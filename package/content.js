// content.js (TVWiki / iframe-friendly patched)
// Goals:
// 1) Chat UI works in top frame only
// 2) Video sync works across cross-origin / nested iframes via postMessage fanout
// 3) Controller frame can be selected with Alt+Click (click the video area)
// 4) Robust injection into related frames requires manifest: match_about_blank + match_origin_as_fallback

(() => {
  "use strict";

  const SERVER_URL = "https://watch-party-server-hv8v.onrender.com";

  // ---- Frame helpers ----
  const MSG_KEY = "__TP_WATCH_PARTY__";
  const FRAME_TOKEN = Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  const isTopFrame = () => (window.top === window);

  // ---- Shared state in each frame ----
  let currentRoom = null;
  let myNickname = "";
  let isRemoteAction = false;

  // Video selection / controller
  let selectedVideo = null;
  let selectedVideoScore = 0;
  let isController = false;
  let activeControllerToken = null;

  // Throttle for time sync emits
  let lastSentTs = 0;
  let lastSentTime = 0;
  let lastSentPaused = null;

  // ---- Logging ----
  const log = (...args) => console.log("[WatchParty]", ...args);

  function postToTop(kind, payload) {
    try {
      if (isTopFrame()) return;
      window.top.postMessage({ [MSG_KEY]: true, kind, token: FRAME_TOKEN, payload }, "*");
    } catch (_) { }
  }

  // Top frame: broadcast to self + child frames recursively (cross-origin safe)
  function broadcastToAllFrames(kind, payload) {
    if (!isTopFrame()) return;
    const msg = { [MSG_KEY]: true, kind, token: FRAME_TOKEN, payload };

    // Send to self
    try { window.postMessage(msg, "*"); } catch (_) { }

    // Recursive fanout
    const visited = new Set();
    const MAX_DEPTH = 8;

    const visit = (w, depth) => {
      if (!w || depth > MAX_DEPTH) return;
      let key;
      try { key = w; } catch (_) { key = Math.random(); }

      if (visited.has(key)) return;
      visited.add(key);

      try { w.postMessage(msg, "*"); } catch (_) { }

      // Enumerate children
      let frames;
      try { frames = w.frames; } catch (_) { frames = null; }
      if (!frames) return;

      try {
        for (let i = 0; i < frames.length; i++) {
          try { visit(frames[i], depth + 1); } catch (_) { }
        }
      } catch (_) { }
    };

    visit(window, 0);
  }

  // ---- Deep video search (supports Shadow DOM) ----
  function getAllVideos(root = document) {
    const videos = [];
    try {
      const els = root.querySelectorAll("video");
      if (els && els.length) videos.push(...Array.from(els));
    } catch (_) { }

    // Shadow roots
    try {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: (node) => (node && node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
        },
        false
      );

      let node;
      while ((node = walker.nextNode())) {
        if (node.shadowRoot) videos.push(...getAllVideos(node.shadowRoot));
      }
    } catch (_) { }

    return videos;
  }

  function findBestVideoInThisFrame() {
    const videos = getAllVideos(document);
    if (!videos.length) return { video: null, score: 0 };

    let best = null;
    let bestScore = 0;

    for (const v of videos) {
      let r;
      try { r = v.getBoundingClientRect(); } catch (_) { continue; }
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      const visibleBoost = (r.width > 40 && r.height > 40) ? 1.0 : 0.05;
      const playingBoost = v.paused ? 1.0 : 1.35;
      const score = area * visibleBoost * playingBoost;

      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return { video: best, score: bestScore };
  }

  function attachVideoListeners(v) {
    if (!v || v.getAttribute("tp-attached") === "1") return;
    v.setAttribute("tp-attached", "1");

    const emit = (type) => {
      if (!currentRoom || !isController || isRemoteAction) return;
      const payload = {
        type,
        time: v.currentTime,
        rate: v.playbackRate,
        roomID: currentRoom
      };
      if (isTopFrame()) {
        socketEmit(payload);
      } else {
        postToTop("video_event", payload);
      }
    };

    v.addEventListener("play", () => emit("play"), true);
    v.addEventListener("pause", () => emit("pause"), true);
    v.addEventListener("seeked", () => emit("seeked"), true);

    v.addEventListener("timeupdate", () => {
      if (!currentRoom || !isController || isRemoteAction) return;
      const now = Date.now();
      if (now - lastSentTs < 1000) return;

      const t = v.currentTime;
      const paused = v.paused;

      if (Math.abs(t - lastSentTime) > 1.5 || paused !== lastSentPaused) {
        lastSentTs = now;
        lastSentTime = t;
        lastSentPaused = paused;
        emit("time_sync");
      }
    }, true);
  }

  function selectVideo(v, score, reason) {
    if (!v) return false;
    if (selectedVideo === v) return true;

    selectedVideo = v;
    selectedVideoScore = score;
    attachVideoListeners(v);

    try {
      // Clear previous outline
      const all = document.querySelectorAll("video");
      all.forEach(el => el.style.outline = "");

      // Set new outline (Green = Controlled)
      v.style.outline = "4px solid #00ff00";
      // Auto-hide after 5s to not annoy, unless strictly requested to keep
      setTimeout(() => {
        try { if (v === selectedVideo) v.style.outline = "2px solid rgba(0,255,0,0.5)"; } catch (_) { }
      }, 2000);
    } catch (_) { }

    log("Video selected:", reason, "score=", score, "href=", location.href);

    // Notify Top Frame about selection to update UI status
    if (isTopFrame()) {
      updateStatusUI(true, isController);
    } else {
      postToTop("ui_status_update", { videoDetected: true });
    }
    return true;
  }

  async function applyRemoteState(data) {
    if (!selectedVideo || !isController) return;

    const v = selectedVideo;
    isRemoteAction = true;

    try {
      // Seek first
      if (typeof data.time === "number" && Math.abs(v.currentTime - data.time) > 1.0) {
        v.currentTime = data.time;
      }

      if (data.type === "pause") {
        v.pause();
      } else if (data.type === "play") {
        const p = v.play();
        if (p && typeof p.then === "function") {
          await p;
        }
      }
      // time_sync: do nothing beyond seek + pause/play correction above
    } catch (e) {
      // Autoplay policies may block play() without a user gesture
      postToTop("ui_notice", { text: `원격 재생 실패(브라우저 정책 가능): ${String(e?.name || e)}` });
      log("Remote control failed:", e);
    } finally {
      setTimeout(() => { isRemoteAction = false; }, 500);
    }
  }

  // ---- Storage sync (room/nick) ----
  function loadRoomNick() {
    try {
      chrome.storage.local.get(["tpRoom", "tpNick"], (r) => {
        if (r.tpRoom) currentRoom = r.tpRoom;
        if (r.tpNick) myNickname = r.tpNick;
        if (isTopFrame() && socket && socket.connected && currentRoom && myNickname) {
          socket.emit("join_room", { roomID: currentRoom, nickname: myNickname });
        }
      });
    } catch (_) { }
  }

  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.tpRoom || changes.tpNick) loadRoomNick();
    });
  } catch (_) { }

  // ---- UI (Top only) ----
  function escapeHtml(s) {
    return (s || "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  const chatHTML = `
    <div id="tp-chat-container">
      <div id="tp-chat-header">Watch Party</div>
      <div id="tp-user-counter" style="background:#222; font-size:10px; padding:4px 10px; color:#00ff00; border-bottom:1px solid #333;">
        접속 중: 0명
      </div>

      <div id="tp-setup-view">
        <input type="text" id="tp-nick-input" placeholder="닉네임 입력">
        <input type="text" id="tp-room-input" placeholder="방 번호 입력">
        <div style="display:flex; gap:5px;">
          <button id="tp-btn-join">입장</button>
          <button id="tp-btn-random">방 만들기</button>
        </div>
        <div style="margin-top:8px; font-size:11px; color:#bbb; line-height:1.35;">
          <div id="tp-status-line" style="margin-bottom:4px; color:#00ff00;">비디오 찾는 중...</div>
          동기화가 안 되면: 영상(플레이어)을 Alt+클릭해 컨트롤러로 지정하세요.<br>
          <button id="tp-btn-rescan" style="margin-top:5px; padding:4px; background:#444; font-size:10px;">🔄 비디오 다시 찾기</button>
        </div>
      </div>

      <div id="tp-active-view" style="display:none; flex:1; flex-direction:column; overflow:hidden;">
        <div id="tp-room-info" style="font-size:11px; padding:5px; background:#444;"></div>
        <div id="tp-chat-messages"></div>
        <div id="tp-chat-input-area">
          <input type="text" id="tp-chat-input" placeholder="메시지 입력">
          <button id="tp-chat-send">전송</button>
        </div>
      </div>
    </div>
  `;

  const styleContent = `
    #tp-chat-container {
      position: fixed; top: 100px; right: 20px; width: 320px; height: 420px;
      background: rgba(33, 33, 33, 0.95); color: white; z-index: 2147483647;
      display: flex; flex-direction: column; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5); font-family: sans-serif; overflow: hidden;
    }
    #tp-chat-header { background: #ff0000; padding: 10px; font-weight: bold; text-align: center; cursor: move; user-select:none; }
    #tp-setup-view { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    #tp-setup-view input { background: #444; border: none; color: white; padding: 10px; border-radius: 6px; outline:none; }
    #tp-setup-view button { background: #ff0000; border: none; color: white; padding: 10px; border-radius: 6px; cursor: pointer; flex: 1; }
    #tp-chat-messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .chat-msg { background: rgba(255,255,255,0.1); padding: 8px; border-radius: 8px; font-size: 13px; max-width: 85%; display: flex; flex-direction: column; }
    .msg-user { font-weight: bold; font-size: 11px; color: #aaa; margin-bottom: 2px; }
    .chat-msg.mine { align-self: flex-end; background: #065fd4; }
    .msg-time { font-size: 9px; color: #777; margin-top: 2px; align-self: flex-end; }
    .mine .msg-time { align-self: flex-start; }
    #tp-chat-input-area { display: flex; padding: 10px; gap: 5px; background: #1a1a1a; }
    #tp-chat-input { flex: 1; background: #333; border: none; color: white; padding: 8px; border-radius: 6px; outline: none; }
    #tp-chat-send { background: #ff0000; border: none; color: white; padding: 8px 12px; border-radius: 6px; cursor: pointer; }
    .system-msg { text-align: center; font-size: 11px; color: #bbb; margin: 8px 0; font-style: italic; width: 100%; }
    .toast {
      position: fixed; left: 50%; top: 18px; transform: translateX(-50%);
      background: rgba(0,0,0,0.80); color: white; padding: 8px 12px; border-radius: 8px;
      z-index: 2147483647; font-size: 12px; max-width: 92vw;
    }
  `;

  function showToast(text) {
    if (!isTopFrame()) return;
    try {
      const div = document.createElement("div");
      div.className = "toast";
      div.textContent = text;
      document.body.appendChild(div);
      setTimeout(() => { try { div.remove(); } catch (_) { } }, 2500);
    } catch (_) { }
  }

  function uiSystemMsg(text) {
    if (!isTopFrame()) return;
    const box = document.getElementById("tp-chat-messages");
    if (!box) return;
    const div = document.createElement("div");
    div.className = "system-msg";
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function updateStatusUI(found, controller) {
    const el = document.getElementById("tp-status-line");
    if (el) {
      el.innerHTML = found
        ? `✅비디오 감지됨 <span style='color:${controller ? "#00ff00" : "#aaa"}'>(${controller ? "내 제어" : "상대 제어"})</span>`
        : "❌비디오 없음 (Alt+클릭 해보세요)";
    }
  }

  function uiReceiveChat(data) {
    if (!isTopFrame()) return;
    const box = document.getElementById("tp-chat-messages");
    if (!box) return;

    const isMine = socket && data.senderId === socket.id;
    const div = document.createElement("div");
    div.className = `chat-msg ${isMine ? "mine" : ""}`;
    div.innerHTML = `
      <div class="msg-user">${escapeHtml(data.nickname)}</div>
      <div>${escapeHtml(data.text)}</div>
      <div class="msg-time">${escapeHtml(data.time)}</div>
    `;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function ensureDOMReady(cb) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", cb, { once: true });
    else cb();
  }

  // ---- Socket (Top only) ----
  let socket = null;

  function socketEmit(payload) {
    if (socket && socket.connected) socket.emit("video_state", payload);
  }

  function initTopUI() {
    if (!isTopFrame()) return;

    ensureDOMReady(() => {
      if (!document.getElementById("tp-chat-container")) {
        const s = document.createElement("style");
        s.textContent = styleContent;
        document.head.appendChild(s);
        document.body.insertAdjacentHTML("beforeend", chatHTML);
      }

      // Wire buttons
      const joinBtn = document.getElementById("tp-btn-join");
      const randomBtn = document.getElementById("tp-btn-random");
      const nickEl = document.getElementById("tp-nick-input");
      const roomEl = document.getElementById("tp-room-input");

      if (randomBtn) {
        randomBtn.onclick = () => {
          if (roomEl) roomEl.value = Math.random().toString(36).slice(2, 8).toUpperCase();
        };
      }

      if (joinBtn) {
        joinBtn.onclick = () => {
          const room = (roomEl && roomEl.value || "").trim();
          const nick = (nickEl && nickEl.value || "").trim();
          if (!room || !nick) { alert("닉네임과 방 번호를 입력하세요!"); return; }

          chrome.storage.local.set({ tpRoom: room, tpNick: nick });
          currentRoom = room;
          myNickname = nick;

          const setup = document.getElementById("tp-setup-view");
          const active = document.getElementById("tp-active-view");
          const info = document.getElementById("tp-room-info");
          if (setup) setup.style.display = "none";
          if (active) active.style.display = "flex";
          if (info) info.textContent = `방: ${room} | 닉네임: ${nick}`;

          if (socket && socket.connected) socket.emit("join_room", { roomID: room, nickname: nick });
        };
      }

      // Message send
      const input = document.getElementById("tp-chat-input");
      const sendBtn = document.getElementById("tp-chat-send");
      const sendMessage = () => {
        const text = (input && input.value || "").trim();
        if (!text || !currentRoom || !socket) return;
        socket.emit("send_message", { text, roomID: currentRoom, nickname: myNickname, senderId: socket.id });
        if (input) input.value = "";
      };
      if (sendBtn) sendBtn.onclick = sendMessage;
      if (input) input.onkeypress = (e) => { if (e.key === "Enter") sendMessage(); };

      // Drag
      const con = document.getElementById("tp-chat-container");
      const head = document.getElementById("tp-chat-header");
      let isD = false, oX = 0, oY = 0;
      if (head && con) {
        head.onmousedown = (e) => { isD = true; oX = e.clientX - con.offsetLeft; oY = e.clientY - con.offsetTop; };
        document.onmousemove = (e) => {
          if (!isD) return;
          con.style.left = (e.clientX - oX) + "px";
          con.style.top = (e.clientY - oY) + "px";
          con.style.right = "auto";
        };
        document.onmouseup = () => { isD = false; };
      }

      // Connect socket
      // socket.io is loaded as a content_script resource: socket.io.min.js
      // eslint-disable-next-line no-undef
      socket = io(SERVER_URL);

      socket.on("connect", () => {
        log("Socket connected:", socket.id);
        loadRoomNick();
        if (currentRoom && myNickname) socket.emit("join_room", { roomID: currentRoom, nickname: myNickname });
      });

      socket.on("update_user_count", (cnt) => {
        const el = document.getElementById("tp-user-counter");
        if (el) el.textContent = `접속 중: ${cnt}명`;
      });

      socket.on("user_notification", (msg) => uiSystemMsg(msg));
      socket.on("receive_message", (data) => uiReceiveChat(data));

      // Remote video state -> broadcast to all frames; only controller applies
      socket.on("video_state", (data) => broadcastToAllFrames("remote_state", data));

      // Quick sanity check: if no candidate arrives, notify
      setTimeout(() => {
        if (!activeControllerToken) {
          uiSystemMsg("참고: 아직 '비디오 프레임'이 발견되지 않았습니다. (about:blank/blob/sandbox 프레임일 수 있음) Alt+클릭으로 지정해보세요.");
          updateStatusUI(false, false);
        }
      }, 5000);

      const rescanBtn = document.getElementById("tp-btn-rescan");
      if (rescanBtn) {
        rescanBtn.onclick = () => {
          topState.bestScore = 0;
          topState.bestToken = null;
          broadcastToAllFrames("rescan_request", {});
          reportCandidate(); // Scan self too
          uiSystemMsg("비디오를 다시 검색합니다...");
        };
      }
    });
  }

  // ---- Controller selection and candidate reporting ----
  const topState = { bestToken: null, bestScore: 0, timer: null };

  function reportCandidate() {
    const { video, score } = findBestVideoInThisFrame();
    if (!video) return;

    // Locally select (so controller can act instantly)
    if (!selectedVideo || score > selectedVideoScore * 1.1) {
      selectVideo(video, score, "auto");
    }

    // Tell top frame about this candidate
    if (!isTopFrame()) postToTop("candidate", { score });
    else {
      // Top can also be the candidate (if the video is in top)
      if (score > topState.bestScore) {
        topState.bestScore = score;
        topState.bestToken = FRAME_TOKEN;
      }
    }
  }

  function applyControllerToken(token) {
    activeControllerToken = token;
    isController = (FRAME_TOKEN === token);
    if (isController) log("I am controller. href=", location.href);
  }

  // Alt+Click: force controller to the frame the user clicked in
  window.addEventListener("click", (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();

    const { video, score } = findBestVideoInThisFrame();

    // [Fix] Even if no video detected by safe logic, try to find ANY video under the click target
    // sometimes e.target IS the video or a wrapper
    let targetVideo = video;
    if (!targetVideo && e.target.tagName === "VIDEO") targetVideo = e.target;

    if (!targetVideo) {
      if (isTopFrame()) showToast("이 프레임엔 비디오가 없습니다.");
      return;
    }

    // Force selection
    selectVideo(targetVideo, score || 9999, "user-forced");
    showToast("비디오 강제 선택됨!");

    if (isTopFrame()) {
      applyControllerToken(FRAME_TOKEN);
      broadcastToAllFrames("set_controller", { activeToken: FRAME_TOKEN });
      updateStatusUI(true, true);
      uiSystemMsg("Alt+클릭으로 컨트롤러 지정됨.");
    } else {
      postToTop("force_controller", { score: 9999 });
      postToTop("ui_notice", { text: "Alt+클릭 컨트롤러 요청 전송됨." });
    }
  }, true);

  // ---- Message handling ----
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d[MSG_KEY] !== true) return;

    if (isTopFrame()) {
      if (d.kind === "candidate") {
        if (typeof d.payload?.score === "number" && d.payload.score > topState.bestScore) {
          topState.bestScore = d.payload.score;
          topState.bestToken = d.token;

          clearTimeout(topState.timer);
          topState.timer = setTimeout(() => {
            activeControllerToken = topState.bestToken;
            broadcastToAllFrames("set_controller", { activeToken: topState.bestToken });
            if (FRAME_TOKEN === topState.bestToken) applyControllerToken(FRAME_TOKEN);
          }, 800);
        }
      } else if (d.kind === "force_controller") {
        activeControllerToken = d.token;
        broadcastToAllFrames("set_controller", { activeToken: d.token });
        uiSystemMsg("Alt+클릭으로 컨트롤러가 변경되었습니다.");
      } else if (d.kind === "video_event") {
        socketEmit(d.payload);
      } else if (d.kind === "ui_notice") {
        if (d.payload?.text) uiSystemMsg(String(d.payload.text));
      }
    } else {
      if (d.kind === "set_controller") {
        applyControllerToken(d.payload?.activeToken);
      } else if (d.kind === "remote_state") {
        applyRemoteState(d.payload);
      } else if (d.kind === "rescan_request") {
        reportCandidate();
      }
    }

    // Handle status update from child frames
    if (isTopFrame() && d.kind === "ui_status_update") {
      updateStatusUI(true, activeControllerToken === d.token); // Approximate check
    }
  });

  // ---- Start ----
  loadRoomNick();

  // periodic scan in every frame
  setInterval(reportCandidate, 2000);

  // Top frame initializes UI + socket
  if (isTopFrame()) {
    initTopUI();
    // default controller = top until a better candidate appears
    applyControllerToken(FRAME_TOKEN);
    broadcastToAllFrames("set_controller", { activeToken: FRAME_TOKEN });
  }
})();
