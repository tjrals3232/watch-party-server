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
        socket.to(data.roomID).emit('video_state', data);
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