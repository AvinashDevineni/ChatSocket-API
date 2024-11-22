const url = require('url');
const express = require('express');
const app = express();
const cors = require('cors');
const mongoose = require('mongoose');
const Room = require('./models/Room.model');
const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;
require('dotenv').config()

main();

async function main() {
    //#region WSS Creation Definition
    function serverMessage(msg) {
        return {
            from: 'server',
            message: msg
        };
    }

    function getPathedWssInfo(pathedWSS) {
        return {
            name: pathedWSS.name,
            path: pathedWSS.path,
            numPeople: pathedWSS.wss.clients.size
        };
    }

    function createServerlessWSS(wssOptions) {
        const wss = new WebSocketServer({ noServer: true });
        wss.on('connection', ws => {
            ws.on('error', (e) => console.log(e));

            ws.on('close', () => wssOptions.leaveAction(ws));

            ws.on('message', msg => {
                wss.clients.forEach(client => {
                    const isReady = client.readyState === WebSocket.OPEN;
                    if (wssOptions.shouldSendToSelf ? isReady : (client !== ws && isReady))
                        client.send(msg);
                });
            });

            wssOptions.joinAction(ws);
        });

        return wss;
    }

    class WssOptions {
        constructor(joinAction = ws => ws.emit('message', new Blob([serverMessage('New Person Joined')])),
                    leaveAction = ws => ws.emit('message', new Blob([serverMessage('Person Left')])),
                    shouldSendToSelf = true) {
            this.joinAction = joinAction;
            this.leaveAction = leaveAction;
            this.shouldSendToSelf = shouldSendToSelf;
        }
    }

    class PathedWebSocketServer {
        constructor(mainWss, path, name, serverOptions = new WssOptions(
                        ws => {
                            ws.emit('message', new Blob([JSON.stringify(serverMessage('New Person Joined'))]));
                            notifyPathedWss(mainWss, new Blob([JSON.stringify(getPathedWssInfo(this))]));
                        },
                        ws => {
                            ws.emit('message', new Blob([JSON.stringify(serverMessage('Person Left'))]));
                            notifyPathedWss(mainWss, new Blob([JSON.stringify(getPathedWssInfo(this))]));
                        }
                    ),
                    createNow = true) {
            this.path = path;
            this.name = name;

            if (createNow)
                this.wss = createServerlessWSS(serverOptions);
        }

        createWss(serverOptions = new WssOptions()) {
            wss = createServerlessWSS(this.name, serverOptions);
        }
    }
    //#endregion

    console.log('connecting to db');
    await mongoose.connect(process.env.MONGO_URL);
    console.log('connected to db')

    const rooms = await Room.find({});
    console.log(rooms);

    const mainWss = new PathedWebSocketServer(null, '/', 'Main', new WssOptions(ws => {}, ws => {}));
    // to know type of wsRooms
    let wsRooms = [new PathedWebSocketServer('', '', false)];
    wsRooms = [];
    for (const room of rooms) {
        wsRooms.push(new PathedWebSocketServer(
            mainWss, `/room/${encodeURI(room.name.toLowerCase())}`, room.name
        ));
    }
    
    function notifyPathedWss(pathedWSS, ...args) {
        for (const ws of pathedWSS.wss.clients) {
            ws.emit('message', ...args);
            break;
        }
    }
    
    //#region App & Server Initialization
    app.use(express.json());
    app.use(cors());
    
    app.post('/room', (req, res) => {
        const roomName = req.body.roomName;
        const roomPath = `/room/${encodeURI(roomName.toLowerCase())}`;
    
        for (const wss of wsRooms) {
            if (wss.path === roomPath)
                return res.status(400).json({ error: 'Room with same name already exists.' });
        }

        Room.create({ name: roomName });
    
        const wss = new PathedWebSocketServer(mainWss, roomPath, roomName);
        wsRooms.push(wss);
    
        const wssInfo = getPathedWssInfo(wss);
        // notify about new room
        notifyPathedWss(mainWss, new Blob([JSON.stringify(wssInfo)]));
    
        res.json(wssInfo);
    });
    
    app.get('/room', (req, res) => {
        if (req.body.path) {
            const room = getRoomMatchingPath(req.body.path);
            if (room === null)
                return res.status(400).json({ 'error': 'Path given doesn\'t not exist.' });
    
            return res.json(getPathedWssInfo(room));
        }
    
        res.json({ rooms: getAllRooms() });
    });
    
    app.get('/room/:roomName', (req, res) => {
        const roomName = req.params.roomName;
        
        let roomWss = null;
        for (const wss of wsRooms) {
            if (wss.name === roomName) {
                roomWss = wss;
                break;
            }
        }
    
        if (roomWss == null)
            return res.status(400).json({ error: `Room ${roomName} does not exist.` });
    
        res.json(getPathedWssInfo(wss));
    });
    
    function getAllRooms() {
        const rooms = [];
        wsRooms.forEach(wss => rooms.push(getPathedWssInfo(wss)));
        return rooms;
    }
    
    function getRoomMatchingPath(path) {
        wsRooms.forEach(wss => {
            if (wss.path === path)
                return wss;
        });
    
        return null;
    }
    
    const server = app.listen(4000, () => {
        console.log('Go to http://localhost:4000');
    });
    //#endregion
    
    server.on('upgrade', (req, socket, head) => {
        const reqUrl = url.parse(req.url);
        
        if (reqUrl.pathname === mainWss.path) {
            mainWss.wss.handleUpgrade(req, socket, head, ws => mainWss.wss.emit('connection', ws));
            return;
        }
    
        for (const wss of wsRooms) {
            if (reqUrl.pathname === wss.path) {
                wss.wss.handleUpgrade(req, socket, head, ws => wss.wss.emit('connection', ws));
                return;
            }
        }
    
        console.log('Upgrade Failed\n');
        
        socket.destroy();
    });
}
