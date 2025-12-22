// content.js
const socket = io("https://watch-party-server-hv8v.onrender.com");
let isRemoteAction = false;
let currentRoom = null;
let myNickname = "";

// 1. UI 구조 및 스타일 정의 (최상단으로 이동)
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
        </div>
        <div id="tp-active-view" style="display:none; flex:1; flex-direction:column; overflow:hidden;">
            <div id="tp-room-info" style="font-size:11px; padding:5px; background:#444;"></div>
            <div id="tp-chat-messages"></div>
            <div id="tp-chat-input-area">
                <input type="text" id="tp-chat-input" placeholder="메시지 입력...">
                <button id="tp-chat-send">전송</button>
            </div>
        </div>
    </div>
`;

const style = document.createElement('style');
style.innerHTML = `
    #tp-chat-container {
        position: fixed; top: 100px; right: 20px; width: 300px; height: 400px;
        background: rgba(33, 33, 33, 0.95); color: white; z-index: 9999;
        display: flex; flex-direction: column; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5); font-family: sans-serif; overflow: hidden;
    }
    #tp-chat-header { background: #ff0000; padding: 10px; font-weight: bold; text-align: center; cursor: move; }
    #tp-setup-view { padding: 20px; display: flex; flex-direction: column; gap: 10px; }
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
    .system-msg { text-align: center; font-size: 11px; color: #999; margin: 8px 0; font-style: italic; }
`;

// 2. 핵심 로직 함수 정의
const performJoinRoom = (room, nick) => {
    if (!room || !nick) return alert("닉네임과 방 번호를 입력하세요!");
    currentRoom = room;
    myNickname = nick;
    
    socket.off('update_user_count');
    socket.off('receive_message');
    socket.off('user_notification');

    socket.on('update_user_count', (count) => {
        const counter = document.getElementById('tp-user-counter');
        if (counter) counter.innerText = `접속 중: ${count}명`;
    });

    socket.on('receive_message', (data) => {
        const msgBox = document.getElementById('tp-chat-messages');
        if (!msgBox) return;
        const isMine = data.senderId === socket.id;
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('chat-msg');
        if (isMine) msgDiv.classList.add('mine');
        
        msgDiv.innerHTML = `
            <div class="msg-user">${data.nickname}</div>
            <div class="msg-content-wrapper">
                <div style="word-break:break-all;">${data.text}</div>
                <div class="msg-time">${data.time}</div>
            </div>
        `;
        msgBox.appendChild(msgDiv);
        msgBox.scrollTop = msgBox.scrollHeight;
    });

    socket.on('user_notification', (msg) => {
        const msgBox = document.getElementById('tp-chat-messages');
        if (!msgBox) return;
        const div = document.createElement('div');
        div.classList.add('system-msg');
        div.innerText = msg;
        msgBox.appendChild(div);
        msgBox.scrollTop = msgBox.scrollHeight;
    });

    socket.emit('join_room', { roomID: currentRoom, nickname: myNickname });
    
    const setupView = document.getElementById('tp-setup-view');
    const activeView = document.getElementById('tp-active-view');
    const roomInfo = document.getElementById('tp-room-info');
    
    if (setupView) setupView.style.display = 'none';
    if (activeView) activeView.style.display = 'flex';
    if (roomInfo) roomInfo.innerText = `방: ${currentRoom} | 닉네임: ${myNickname}`;
};

function autoJoin(room, nick) {
    currentRoom = room;
    myNickname = nick;
    socket.emit('join_room', { roomID: room, nickname: nick });
    console.log(`[Frame] 자동으로 방(${room})에 입장했습니다.`);
}

// 3. UI 생성 및 이벤트 바인딩 (Top Window 전용)
if (window.self === window.top) {
    document.body.insertAdjacentHTML('beforeend', chatHTML);
    document.head.appendChild(style);

    // 드래그 로직
    const chatContainer = document.getElementById('tp-chat-container');
    const chatHeader = document.getElementById('tp-chat-header');
    let isDragging = false, offsetX, offsetY;

    chatHeader.onmousedown = (e) => {
        isDragging = true;
        offsetX = e.clientX - chatContainer.getBoundingClientRect().left;
        offsetY = e.clientY - chatContainer.getBoundingClientRect().top;
    };
    document.onmousemove = (e) => {
        if (!isDragging) return;
        chatContainer.style.left = (e.clientX - offsetX) + 'px';
        chatContainer.style.top = (e.clientY - offsetY) + 'px';
        chatContainer.style.right = 'auto';
    };
    document.onmouseup = () => isDragging = false;

    // 입장 버튼 클릭 핸들러
    document.getElementById('tp-btn-join').onclick = () => {
        const room = document.getElementById('tp-room-input').value;
        const nick = document.getElementById('tp-nick-input').value;
        chrome.storage.local.set({ tpRoom: room, tpNick: nick });
        performJoinRoom(room, nick);
    };

    document.getElementById('tp-btn-random').onclick = () => {
        document.getElementById('tp-room-input').value = Math.random().toString(36).substring(2, 8).toUpperCase();
    };

    // 메시지 전송 로직
    const input = document.getElementById('tp-chat-input');
    const sendBtn = document.getElementById('tp-chat-send');

    const sendMessage = () => {
        const text = input.value.trim();
        if (text && currentRoom) {
            socket.emit('send_message', { 
                text: text, 
                roomID: currentRoom, 
                nickname: myNickname, 
                senderId: socket.id 
            });
            input.value = '';
        }
    };
    sendBtn.onclick = sendMessage;
    input.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };
}

// 4. 공통 리스너 (모든 프레임)
chrome.storage.onChanged.addListener((changes) => {
    if (changes.tpRoom || changes.tpNick) {
        chrome.storage.local.get(['tpRoom', 'tpNick'], (res) => {
            if (res.tpRoom && res.tpNick) autoJoin(res.tpRoom, res.tpNick);
        });
    }
});

function initVideoControl() {
    const video = document.querySelector('video');
    if (!video) {
        setTimeout(initVideoControl, 1000);
        return;
    }
    console.log("동기화 대상 영상을 찾았습니다!");

    let lastTime = video.currentTime;
    let lastPaused = video.paused;

    setInterval(() => {
        if (isRemoteAction || !currentRoom) return;
        if (video.paused !== lastPaused || Math.abs(video.currentTime - lastTime) > 1.5) {
            const state = video.paused ? 'pause' : 'play';
            socket.emit('video_state', { type: state, time: video.currentTime, roomID: currentRoom });
        }
        lastTime = video.currentTime;
        lastPaused = video.paused;
    }, 500);

    socket.on('video_state', (data) => {
        isRemoteAction = true;
        if (data.type === 'play') video.play();
        else if (data.type === 'pause') video.pause();
        if (Math.abs(video.currentTime - data.time) > 1.0) video.currentTime = data.time;
        setTimeout(() => { isRemoteAction = false; }, 500);
    });
}
initVideoControl();