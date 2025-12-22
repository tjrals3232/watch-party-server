// content.js
const socket = io("https://watch-party-server-hv8v.onrender.com");
let isRemoteAction = false;
let currentRoom = null;
let myNickname = "";

// --- [공통 함수] 영상 탐색 로직 ---
function findVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    return videos.reduce((prev, curr) => 
        (prev.offsetWidth * prev.offsetHeight > curr.offsetWidth * curr.offsetHeight) ? prev : curr
    );
}

// --- [공통 로직] 모든 프레임에서 방 정보를 동기화 ---
const updateRoomInfo = (room, nick) => {
    currentRoom = room;
    myNickname = nick;
    socket.emit('join_room', { roomID: room, nickname: nick });
};

// 초기 실행 시 저장된 정보가 있으면 자동 입장
chrome.storage.local.get(['tpRoom', 'tpNick'], (res) => {
    if (res.tpRoom && res.tpNick) updateRoomInfo(res.tpRoom, res.tpNick);
});

// 저장소 변경 감지 (입장 시 모든 프레임 동시 입장)
chrome.storage.onChanged.addListener((changes) => {
    if (changes.tpRoom || changes.tpNick) {
        chrome.storage.local.get(['tpRoom', 'tpNick'], (res) => {
            if (res.tpRoom && res.tpNick) updateRoomInfo(res.tpRoom, res.tpNick);
        });
    }
});

// --- [메인 페이지 전용] UI 및 채팅 로직 ---
if (window.self === window.top) {
    // UI 생성 (기존 chatHTML, style 변수 정의 부분 생략 - 그대로 사용하세요)
    const style = document.createElement('style');
    style.innerHTML = `...기존 스타일...`; //
    document.head.appendChild(style);
    document.body.insertAdjacentHTML('beforeend', chatHTML);

    // 채팅 수신 리스너 (Top에서만 동작하여 중복 방지)
    socket.on('receive_message', (data) => {
        const msgBox = document.getElementById('tp-chat-messages');
        if (!msgBox) return;
        const isMine = data.senderId === socket.id;
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('chat-msg');
        if (isMine) msgDiv.classList.add('mine');
        msgDiv.innerHTML = `<div class="msg-user">${data.nickname}</div><div class="msg-content-wrapper"><div>${data.text}</div><div class="msg-time">${data.time}</div></div>`;
        msgBox.appendChild(msgDiv);
        msgBox.scrollTop = msgBox.scrollHeight;
    });

    // 입장 버튼 로직
    document.getElementById('tp-btn-join').onclick = () => {
        const room = document.getElementById('tp-room-input').value;
        const nick = document.getElementById('tp-nick-input').value;
        if (!room || !nick) return alert("닉네임과 방 번호를 입력하세요!");
        chrome.storage.local.set({ tpRoom: room, tpNick: nick });
        
        document.getElementById('tp-setup-view').style.display = 'none';
        document.getElementById('tp-active-view').style.display = 'flex';
        document.getElementById('tp-room-info').innerText = `방: ${room} | 닉네임: ${nick}`;
    };

    // 메시지 전송 및 기타 UI 이벤트 (드래그 등) 코드는 여기에 위치
}

// --- [비디오 제어 로직] 모든 프레임에서 각자의 영상을 감시 ---
function initVideoControl() {
    const video = findVideo(); // 개선된 탐색 함수 사용
    if (!video) {
        setTimeout(initVideoControl, 1000);
        return;
    }

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
        setTimeout(() => { isRemoteAction = false; }, 600); 
    });
}
initVideoControl();