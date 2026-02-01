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
        // [Fix] 중복 입장 방지
        const prev = users[socket.id];
        if (prev) {
            if (prev.roomID === data.roomID && prev.nickname === data.nickname) {
                return; // 완전히 동일하면 무시
            }
            // 방을 바꾸거나 닉네임을 바꾼 경우 -> 이전 방 퇴장 처리
            socket.leave(prev.roomID);
            io.to(prev.roomID).emit('user_notification', `${prev.nickname}님이 이동하셨습니다.`);
            emitUserCount(prev.roomID);
        }

        socket.join(data.roomID);
        users[socket.id] = { roomID: data.roomID, nickname: data.nickname };

        console.log(`[${data.roomID}] ${data.nickname} 입장`);

        io.to(data.roomID).emit('user_notification', `${data.nickname}님이 입장하셨습니다.`);
        emitUserCount(data.roomID);
    });

    // server.js 내부 수정

    socket.on('video_state', (data) => {
        const user = users[socket.id];
        if (user) {
            let actionText = "";
            const timeStr = formatTime(data.time);

            // [수정 핵심] if-else 문을 명확하게 분리하여 필요한 이벤트만 처리합니다.

            if (data.type === 'play') {
                // 재생 시 알림
                actionText = `${user.nickname}님이 영상을 재생했습니다.`;
            }
            else if (data.type === 'pause') {
                // 일시정지 시 알림
                actionText = `${user.nickname}님이 영상을 일시정지했습니다.`;
            }
            else if (data.type === 'seeked') {
                // [중요] 타임바 조작이 '완료'되었을 때만 알림 (드래그 중인 seeking 제외)
                actionText = `${user.nickname}님이 ${timeStr} 지점으로 이동했습니다.`;
            }

            // [참고] 'time_sync'(자동 동기화), 'seeking'(탐색 중), 'rate'(배속) 등은
            // 위 조건문에 없으므로 actionText가 빈 문자열("")이 됩니다.

            // 1. 영상 상태 데이터는 '나를 제외한' 사람들에게 항상 전송 (동기화 기능)
            socket.to(data.roomID).emit('video_state', data);

            // 2. 채팅 알림은 actionText가 존재할 때만(재생, 일시정지, 탐색완료) 전송
            if (actionText) {
                io.to(data.roomID).emit('user_notification', actionText);
            }
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