// content.js (PATCH VERSION)
// - Socket connection: TOP FRAME ONLY
// - Frame communication: window.postMessage (cross-origin safe)
// - Video sync: event-based (play/pause/seeking/seeked/timeupdate throttled)
// - Video selection: Alt+Click to force controller frame/video
// - Controller election: largest visible video across frames (auto), with override by Alt+Click

(() => {
  "use strict";

  const SERVER_URL = "https://watch-party-server-hv8v.onrender.com";

  // ======= Shared State (per frame) =======
  const FRAME_TOKEN = `${Math.random().toString(36).slice(2)}-${Date.now()}`;
  let currentRoom = null;
  let myNickname = "";

  // controller coordination
  let activeControllerToken = null;
  let isController = false;

  // video selection in this frame
  let selectedVideo = null;
  let selectedVideoScore = 0;

  // remote action guard (per frame)
  let isRemoteAction = false;

  // timeupdate throttle
  let lastSentTs = 0;
  let lastSentTime = 0;
  let lastSentPaused = null;
  let lastSentRate = 1;

  // ======= UI (TOP FRAME ONLY) =======
  // 기존 UI는 그대로 유지 + 시스템 메시지 출력 함수만 추가
  const chatHTML = `
    <div id="tp-chat-container">
      <div id="tp-chat-header">Watch Party</div>
      <div id="tp-user-counter" style="background:#222; font-size:10px; padding:4px 10px; color:#00ff00; border-bottom:1px solid #333;">
        접속 중: 1명
      </div>

      <div id="tp-setup-view">
        <input type="text" id="tp-nick-input" placeholder="닉네임 입력">
        <input type="text" id="tp-room-input" placeholder="방 번호 입력">
        <div style="display:flex; gap:5px;">
          <button id="tp-btn-join">입장</button>
          <button id="tp-btn-random">방 만들기</button>
        </div>
        <div style="font-size:11px; color:#bbb; margin-top:8px; line-height:1.4;">
          팁: 동기화가 안 되면 영상 위에서 <b>Alt+클릭</b>하여 플레이어를 지정하세요.
        </div>
      </div>

      <div id="tp-active-view" style="display:none; flex:1; flex-direction:column; overflow:hidden;">
        <div id="tp-room-info" style="font-size:11px; padding:5px; background:#444;"></div>
        <div id="tp-chat-messages"></div>
        <div id="tp-chat-input-area">
          <input type="text" id="tp-chat-input" placeholder="메시지 입력.">
          <button id="tp-chat-send">전송</button>
        </div>
      </div>
    </div>
  `;

  const styleContent = `
    #tp-chat-container {
      position: fixed; top: 100px; right: 20px; width: 300px; height: 420px;
      background: rgba(33, 33, 33, 0.95); color: white; z-index: 2147483647;
      display: flex; flex-direction: column; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5); font-family: sans-serif; overflow: hidden;
    }
    #tp-chat-header { background: #ff0000; padding: 10px; font-weight: bold; text-align: center; cursor: move; }
    #tp-setup-view { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    #tp-setup-view input { background: #444; border: none; color: white; padding: 10px; border-radius: 4px; }
    #tp-setup-view button { background: #ff0000; border: none; color: white; padding: 10px; border-radius: 4px; cursor: pointer; flex: 1; }
    #tp-chat-messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .chat-msg { background: rgba(255,255,255,0.1); padding: 8px; border-radius: 8px; font-size: 13px; max-width: 85%; display: flex; flex-direction: column; }
    .msg-user { font-weight: bold; font-size: 11px; color: #aaa; margin-bottom: 2px; }
    .chat-msg.mine { align-self: flex-end; background: #065fd4; }
    .msg-content-wrapper { display: flex; flex-direction: column; }
    .msg-time { font-size: 9px; color: #777; margin-top: 2px; align-self: flex-end; }
    .mine .msg-time { align-self: flex-start; }
    #tp-chat-input-area { display: flex; padding: 10px; gap: 5px; background: #1a1a1a; }
    #tp-chat-input { flex: 1; background: #333; border: none; color: white; padding: 8px; border-radius: 4px; outline: none; }
    #tp-chat-send { background: #ff0000; border: none; color: white; padding: 8px 12px; border-radius: 4px; cursor: pointer; }
    .system-msg { text-align: center; font-size: 11px; color: #999; margin: 8px 0; font-style: italic; width: 100%; }
    .tp-toast {
      position: fixed; left: 12px; bottom: 12px; z-index: 2147483647;
      background: rgba(0,0,0,0.75); color: #fff; padding: 8px 10px; border-radius: 8px;
      font-size: 12px; font-family: system-ui, sans-serif;
      max-width: 80vw;
    }
  `;

  function ensureDOMReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function showToast(text) {
    try {
      const id = "tp-toast";
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        el.className = "tp-toast";
        document.documentElement.appendChild(el);
      }
      el.textContent = text;
      el.style.display = "block";
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => {
        if (el) el.style.display = "none";
      }, 2500);
    } catch (_) {}
  }

  // ======= Video Finding / Scoring =======
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 90) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    if (r.top > (window.innerHeight || 0) || r.left > (window.innerWidth || 0)) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity || "1") === 0) return false;
    return true;
  }

  function scoreVideo(v) {
    const r = v.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    const visibleBoost = isVisible(v) ? 1.0 : 0.15;
    const playingBoost = v.paused ? 1.0 : 1.25;
    return area * visibleBoost * playingBoost;
  }

  function findBestVideoInThisFrame() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return { video: null, score: 0 };

    let best = null;
    let bestScore = 0;
    for (const v of videos) {
      const s = scoreVideo(v);
      if (s > bestScore) {
        bestScore = s;
        best = v;
      }
    }
    return { video: best, score: bestScore };
  }

  function selectVideo(v, score, reason) {
    if (!v) return false;
    selectedVideo = v;
    selectedVideoScore = score || scoreVideo(v);

    // reset last sent
    lastSentTs = 0;
    lastSentTime = v.currentTime || 0;
    lastSentPaused = v.paused;
    lastSentRate = v.playbackRate || 1;

    attachVideoListeners(v);
    showToast(`[Watch Party] 비디오 선택됨 (${reason})`);
    return true;
  }

  // ======= Frame <-> Top messaging (postMessage) =======
  const MSG_KEY = "__TP_WATCH_PARTY__";

  function postToTop(kind, payload) {
    if (window.top === window) return; // top itself handles directly
    window.top.postMessage(
      {
        [MSG_KEY]: true,
        kind,
        token: FRAME_TOKEN,
        payload,
      },
      "*"
    );
  }

  function broadcastToAllFrames(kind, payload) {
    // only top should broadcast
    if (window.top !== window) return;

    const msg = { [MSG_KEY]: true, kind, token: FRAME_TOKEN, payload };

    const visit = (w, depth) => {
      if (!w || depth > 6) return; // prevent runaway
      try {
        // send to this window
        w.postMessage(msg, "*");
      } catch (_) {}

      // recurse to children
      try {
        const frames = w.frames;
        for (let i = 0; i < frames.length; i++) {
          try {
            visit(frames[i], depth + 1);
          } catch (_) {}
        }
      } catch (_) {}
    };

    visit(window, 0);
  }

  // ======= Controller election =======
  // Each frame reports its best video candidate to TOP.
  function reportCandidate() {
    const { video, score } = findBestVideoInThisFrame();
    if (!video || score <= 0) return;

    // Keep local auto-selection (but not forcing controller)
    if (!selectedVideo || score > selectedVideoScore * 1.15) {
      selectVideo(video, score, "auto");
    }

    postToTop("candidate", { score });
  }

  // TOP chooses the highest score frame as controller (unless user forces).
  const topControllerState = {
    forcedToken: null,
    bestToken: null,
    bestScore: 0,
    chooseTimer: null,
  };

  function topScheduleChooseController() {
    if (window.top !== window) return;

    clearTimeout(topControllerState.chooseTimer);
    topControllerState.chooseTimer = setTimeout(() => {
      const tokenToUse = topControllerState.forcedToken || topControllerState.bestToken;
      if (!tokenToUse) return;

      activeControllerToken = tokenToUse;
      isController = (FRAME_TOKEN === tokenToUse);

      broadcastToAllFrames("set_controller", { activeToken: tokenToUse });

      // reset for next rounds (keep forced token until changed)
      topControllerState.bestToken = null;
      topControllerState.bestScore = 0;

      // optional: notify UI
      if (isTopFrame()) {
        uiSystemMsg(`컨트롤러 프레임이 설정되었습니다. (token: ${tokenToUse.slice(0, 6)}...)`);
      }
    }, 800);
  }

  function isTopFrame() {
    return window.top === window;
  }

  function applyControllerToken(token) {
    activeControllerToken = token;
    isController = (FRAME_TOKEN === token);
    if (isController) {
      showToast("[Watch Party] 이 프레임이 컨트롤러입니다.");
    }
  }

  // ======= Video event handling =======
  let listenersAttached = false;

  function attachVideoListeners(v) {
    if (!v) return;
    if (listenersAttached) return;
    listenersAttached = true;

    const emit = (type, extra = {}) => {
      if (!currentRoom) return;
      if (isRemoteAction) return;
      if (!isController) return; // only controller sends

      const payload = {
        type,
        time: v.currentTime || 0,
        rate: v.playbackRate || 1,
        roomID: currentRoom,
        ...extra,
      };

      if (isTopFrame()) {
        // top can send directly (via socket)
        topEmitVideoState(payload);
      } else {
        postToTop("video_event", payload);
      }
    };

    const onPlay = () => emit("play");
    const onPause = () => emit("pause");
    const onSeeking = () => emit("seeking");
    const onSeeked = () => emit("seeked");
    const onRate = () => emit("rate");

    const onTimeUpdate = () => {
      if (!currentRoom) return;
      if (isRemoteAction) return;
      if (!isController) return;

      const now = Date.now();
      const t = v.currentTime || 0;

      // throttle: at most once per 800ms
      if (now - lastSentTs < 800) return;

      // send if drift is meaningful
      const paused = v.paused;
      const rate = v.playbackRate || 1;

      const timeDelta = Math.abs(t - lastSentTime);
      const pausedChanged = lastSentPaused === null ? false : (paused !== lastSentPaused);
      const rateChanged = Math.abs(rate - lastSentRate) > 0.001;

      // While playing, small jitter is normal; focus on larger drift
      const threshold = paused ? 1.0 : 1.75;

      if (timeDelta >= threshold || pausedChanged || rateChanged) {
        lastSentTs = now;
        lastSentTime = t;
        lastSentPaused = paused;
        lastSentRate = rate;
        emit("time_sync");
      }
    };

    v.addEventListener("play", onPlay, true);
    v.addEventListener("pause", onPause, true);
    v.addEventListener("seeking", onSeeking, true);
    v.addEventListener("seeked", onSeeked, true);
    v.addEventListener("ratechange", onRate, true);
    v.addEventListener("timeupdate", onTimeUpdate, true);

    // If video element is replaced, listenersAttached can become stale.
    // We keep it simple: MutationObserver will re-probe and a hard refresh resets.
  }

  async function applyRemoteStateToVideo(data) {
    if (!selectedVideo) return;
    if (!isController) return; // only controller applies, avoids multi-apply chaos

    const v = selectedVideo;

    isRemoteAction = true;
    try {
      // rate sync (optional)
      if (typeof data.rate === "number" && Math.abs((v.playbackRate || 1) - data.rate) > 0.05) {
        try { v.playbackRate = data.rate; } catch (_) {}
      }

      // time sync (apply first for better UX on play)
      if (typeof data.time === "number" && Math.abs((v.currentTime || 0) - data.time) > 0.75) {
        try { v.currentTime = data.time; } catch (_) {}
      }

      if (data.type === "play") {
        try {
          await v.play();
        } catch (e) {
          // play is often blocked without user gesture on many sites
          notifyPlayBlocked(e);
        }
      } else if (data.type === "pause") {
        try { v.pause(); } catch (_) {}
      } else {
        // seeking/time_sync/rate etc: already handled by time/rate set above
      }
    } finally {
      setTimeout(() => { isRemoteAction = false; }, 700);
    }
  }

  function notifyPlayBlocked(err) {
    const msg =
      "재생이 차단되었습니다. 플레이어(영상 영역)를 한 번 클릭한 뒤 다시 시도하세요. " +
      "(사이트 자동재생 정책/보안 설정 때문일 수 있습니다.)";

    if (isTopFrame()) {
      uiSystemMsg(msg);
    } else {
      postToTop("ui_notify", { text: msg });
    }

    // optional debug
    // console.log("[TP] play blocked:", err);
  }

  // ======= Room/Nick Sync (storage) =======
  function setRoomNick(room, nick) {
    currentRoom = room;
    myNickname = nick;
  }

  chrome.storage.local.get(["tpRoom", "tpNick"], (res) => {
    if (res.tpRoom && res.tpNick) {
      setRoomNick(res.tpRoom, res.tpNick);
      if (isTopFrame()) {
        topJoinRoom(res.tpRoom, res.tpNick);
      }
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.tpRoom || changes.tpNick) {
      chrome.storage.local.get(["tpRoom", "tpNick"], (res) => {
        if (res.tpRoom && res.tpNick) {
          setRoomNick(res.tpRoom, res.tpNick);
          if (isTopFrame()) {
            topJoinRoom(res.tpRoom, res.tpNick);
          }
        }
      });
    }
  });

  // ======= TOP FRAME: Socket + UI =======
  let socket = null;
  let joinedOnce = false;

  function topConnectSocket() {
    if (!isTopFrame()) return;
    if (socket) return;

    // io()는 socket.io.min.js에서 제공
    socket = io(SERVER_URL);

    socket.on("connect", () => {
      // console.log("[TP] socket connected:", socket.id);
      if (currentRoom && myNickname) {
        topJoinRoom(currentRoom, myNickname);
      }
    });

    socket.on("update_user_count", (count) => {
      const counter = document.getElementById("tp-user-counter");
      if (counter) counter.innerText = `접속 중: ${count}명`;
    });

    // (Top frame) 시스템 알림 수신 (영상 제어, 입장/퇴장)
socket.on('user_notification', (msg) => {
  const msgBox = document.getElementById('tp-chat-messages');
  if (!msgBox) return;
  const div = document.createElement('div');
  div.classList.add('system-msg');
  div.innerText = msg;
  msgBox.appendChild(div);
  msgBox.scrollTop = msgBox.scrollHeight;
});

    socket.on("receive_message", (data) => {
      uiReceiveChat(data);
    });

    // Server -> clients (video sync)
    socket.on("video_state", (data) => {
      // broadcast to ALL frames; only controller frame will apply
      broadcastToAllFrames("remote_state", data);
    });
  }

  function topJoinRoom(room, nick) {
    if (!socket) topConnectSocket();
    if (!socket) return;

    // Avoid flooding join_room repeatedly
    // (still allow re-join if room changes)
    socket.emit("join_room", { roomID: room, nickname: nick });
    joinedOnce = true;
  }

  function topEmitVideoState(payload) {
    if (!isTopFrame()) return;
    if (!socket) return;
    if (!payload || !payload.roomID) return;
    socket.emit("video_state", payload);
  }

  function uiSystemMsg(text) {
    if (!isTopFrame()) return;
    const box = document.getElementById("tp-chat-messages");
    if (!box) return;
    const div = document.createElement("div");
    div.className = "system-msg";
    div.innerText = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function uiReceiveChat(data) {
    if (!isTopFrame()) return;
    const msgBox = document.getElementById("tp-chat-messages");
    if (!msgBox) return;
    const isMine = socket && data.senderId === socket.id;

    const msgDiv = document.createElement("div");
    msgDiv.classList.add("chat-msg");
    if (isMine) msgDiv.classList.add("mine");

    const safeNick = (data.nickname ?? "").toString();
    const safeText = (data.text ?? "").toString();
    const safeTime = (data.time ?? "").toString();

    msgDiv.innerHTML =
      `<div class="msg-user">${escapeHtml(safeNick)}</div>` +
      `<div class="msg-content-wrapper">` +
      `<div>${escapeHtml(safeText)}</div>` +
      `<div class="msg-time">${escapeHtml(safeTime)}</div>` +
      `</div>`;

    msgBox.appendChild(msgDiv);
    msgBox.scrollTop = msgBox.scrollHeight;
  }

  function escapeHtml(s) {
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function initTopUI() {
    if (!isTopFrame()) return;

    ensureDOMReady(() => {
      // mount style + UI once
      if (!document.getElementById("tp-chat-container")) {
        const style = document.createElement("style");
        style.innerHTML = styleContent;
        document.head.appendChild(style);
        document.body.insertAdjacentHTML("beforeend", chatHTML);
      }

      topConnectSocket();

      // join button
      const joinBtn = document.getElementById("tp-btn-join");
      if (joinBtn) {
        joinBtn.onclick = () => {
          const room = document.getElementById("tp-room-input").value.trim();
          const nick = document.getElementById("tp-nick-input").value.trim();
          if (!room || !nick) return alert("닉네임과 방 번호를 입력하세요!");
          chrome.storage.local.set({ tpRoom: room, tpNick: nick });

          // UI swap (immediate feedback)
          document.getElementById("tp-setup-view").style.display = "none";
          document.getElementById("tp-active-view").style.display = "flex";
          document.getElementById("tp-room-info").innerText = `방: ${room} | 닉네임: ${nick}`;
        };
      }

      // random room
      const randomBtn = document.getElementById("tp-btn-random");
      if (randomBtn) {
        randomBtn.onclick = () => {
          document.getElementById("tp-room-input").value =
            Math.random().toString(36).substring(2, 8).toUpperCase();
        };
      }

      // message send
      const input = document.getElementById("tp-chat-input");
      const sendBtn = document.getElementById("tp-chat-send");
      const sendMessage = () => {
        const text = (input?.value || "").trim();
        if (!text || !currentRoom) return;
        if (!socket) topConnectSocket();
        if (!socket) return;

        socket.emit("send_message", {
          text,
          roomID: currentRoom,
          nickname: myNickname,
          senderId: socket.id,
        });
        input.value = "";
      };
      if (sendBtn) sendBtn.onclick = sendMessage;
      if (input) input.onkeypress = (e) => { if (e.key === "Enter") sendMessage(); };

      // drag
      const chatContainer = document.getElementById("tp-chat-container");
      const chatHeader = document.getElementById("tp-chat-header");
      let isDragging = false, offsetX = 0, offsetY = 0;

      if (chatHeader && chatContainer) {
        chatHeader.onmousedown = (e) => {
          isDragging = true;
          offsetX = e.clientX - chatContainer.getBoundingClientRect().left;
          offsetY = e.clientY - chatContainer.getBoundingClientRect().top;
        };
        document.onmousemove = (e) => {
          if (!isDragging) return;
          chatContainer.style.left = (e.clientX - offsetX) + "px";
          chatContainer.style.top = (e.clientY - offsetY) + "px";
          chatContainer.style.right = "auto";
        };
        document.onmouseup = () => { isDragging = false; };
      }
    });
  }

  // ======= Alt+Click: force controller + select nearest video =======
  function findVideoFromEvent(e) {
    // Prefer composedPath() for shadow-dom friendly sites (open shadow).
    const path = (typeof e.composedPath === "function") ? e.composedPath() : [];
    for (const node of path) {
      if (node && node.tagName === "VIDEO") return node;
    }

    // fallback: nearest video in document
    const { video } = findBestVideoInThisFrame();
    return video;
  }

  function onAltClickSelect(e) {
    if (!e.altKey) return;
    const v = findVideoFromEvent(e);
    if (!v) {
      showToast("[Watch Party] 이 프레임에서 비디오를 찾지 못했습니다.");
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    selectVideo(v, scoreVideo(v), "alt-click");

    // force controller
    if (isTopFrame()) {
      topControllerState.forcedToken = FRAME_TOKEN;
      applyControllerToken(FRAME_TOKEN);
      broadcastToAllFrames("set_controller", { activeToken: FRAME_TOKEN });
      if (isTopFrame()) uiSystemMsg("Alt+클릭으로 컨트롤러가 강제 지정되었습니다.");
    } else {
      postToTop("force_controller", { score: selectedVideoScore });
    }
  }

  // ======= Message handlers =======
  function onMessage(event) {
    const data = event.data;
    if (!data || data[MSG_KEY] !== true) return;

    // TOP: receives from children
    if (isTopFrame()) {
      if (data.kind === "candidate") {
        // pick best
        const score = Number(data.payload?.score || 0);
        if (!Number.isFinite(score) || score <= 0) return;

        if (score > topControllerState.bestScore) {
          topControllerState.bestScore = score;
          topControllerState.bestToken = data.token;
        }
        topScheduleChooseController();
        return;
      }

      if (data.kind === "force_controller") {
        // user forced from child frame
        topControllerState.forcedToken = data.token;
        applyControllerToken(data.token);
        broadcastToAllFrames("set_controller", { activeToken: data.token });
        uiSystemMsg("Alt+클릭으로 컨트롤러가 강제 지정되었습니다.");
        return;
      }

      if (data.kind === "video_event") {
        // forward to server
        const payload = data.payload;
        if (!payload || !payload.roomID) return;
        topEmitVideoState(payload);
        return;
      }

      if (data.kind === "ui_notify") {
        const text = data.payload?.text;
        if (text) uiSystemMsg(text);
        return;
      }
    }

    // ALL FRAMES: receive from TOP broadcasts
    if (data.kind === "set_controller") {
      const token = data.payload?.activeToken;
      if (!token) return;
      applyControllerToken(token);
      return;
    }

    if (data.kind === "remote_state") {
      // apply remote sync if controller
      applyRemoteStateToVideo(data.payload);
      return;
    }
  }

  // ======= Auto probing / mutation observer =======
  function startAutoProbe() {
    // report candidate periodically (lightweight)
    setInterval(() => {
      reportCandidate();
    }, 2000);

    // also respond to DOM changes (video replaced)
    const mo = new MutationObserver(() => {
      // re-probe after short debounce
      clearTimeout(startAutoProbe._t);
      startAutoProbe._t = setTimeout(() => reportCandidate(), 300);
    });
    try {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }

  // ======= Boot =======
  window.addEventListener("message", onMessage, false);
  window.addEventListener("click", onAltClickSelect, true);

  // In every frame: auto-detect candidate video and participate in election
  ensureDOMReady(() => {
    reportCandidate();
    startAutoProbe();
  });

  // Top frame: mount UI + open socket once
  if (isTopFrame()) {
    initTopUI();

    // Top also sets default controller to itself initially (may be replaced by election)
    activeControllerToken = FRAME_TOKEN;
    isController = true;
  }
})();
