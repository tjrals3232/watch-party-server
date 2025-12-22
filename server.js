// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const users = {}; 

const emitUserCount = (roomID) => {
    const count = io.sockets.adapter.rooms.get(roomID)?.size || 0;
    io.to(roomID).emit('update_user_count', count);
};

// 시간을 00:00 형식으로 변환하는 함수
const formatTime = (seconds) => {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
};

io.on('connection', (socket) => {
    // [추가] 접속 로그
    console.log('접속:', socket.id);

    socket.on('join_room', (data) => {
        socket.join(data.roomID);
        users[socket.id] = { roomID: data.roomID, nickname: data.nickname };
        
        // [추가] 입장 로그
        console.log(`[${data.roomID}] ${data.nickname} 입장`);
        
        io.to(data.roomID).emit('user_notification', `${data.nickname}님이 입장하셨습니다.`);
        emitUserCount(data.roomID);
    });

    socket.on('video_state', (data) => {
        const user = users[socket.id];
        if (user) {
            let actionText = "";
            const timeStr = formatTime(data.time);

            // 상태에 따른 알림 문구 작성
            if (data.type === 'play') {
                actionText = `${user.nickname}님이 영상을 재생했습니다.`;
            } else if (data.type === 'pause') {
                actionText = `${user.nickname}님이 영상을 일시정지했습니다.`;
            } else {
                // seeking 등 시간 이동 시
                actionText = `${user.nickname}님이 ${timeStr} 지점으로 이동했습니다.`;
            }

            // 1. 영상 상태는 '나를 제외한' 사람들에게 전달 (동기화용)
            socket.to(data.roomID).emit('video_state', data);
            
            // 2. 알림 메시지는 '나를 포함한' 모든 사람에게 전달 (채팅창 출력용)
            io.to(data.roomID).emit('user_notification', actionText);
        }
    });

    socket.on('send_message', (data) => {
        const messageData = {
            ...data,
            time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
        };
        io.to(data.roomID).emit('receive_message', messageData);
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            const roomID = user.roomID;
            // [추가] 퇴장 로그
            console.log(`[${roomID}] ${user.nickname} 퇴장`);
            
            io.to(roomID).emit('user_notification', `${user.nickname}님이 퇴장하셨습니다.`);
            delete users[socket.id];
            emitUserCount(roomID);
        }
        console.log('종료:', socket.id);
    });
});

server.listen(3000, () => console.log('서버 실행 중 (Port 3000)'));