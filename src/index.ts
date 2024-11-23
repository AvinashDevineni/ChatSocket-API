import url from 'url';
import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Room from '../models/Room.model.js';
import WebSocket, { WebSocketServer } from 'ws';

const app = express();
dotenv.config();

main();

async function main() {
    //#region WSS Creation Definition
    function serverMessage(msg: string) {
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

    function createServerlessWSS(wssOptions: WssOptions): WebSocketServer {
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
        joinAction: (ws: WebSocket) => void;
        leaveAction: (ws: WebSocket) => void;
        shouldSendToSelf: boolean;

        constructor(joinAction: (ws: WebSocket) => void, leaveAction: (ws: WebSocket) => void,
                    shouldSendToSelf = true) {
            this.joinAction = joinAction;
            this.leaveAction = leaveAction;
            this.shouldSendToSelf = shouldSendToSelf;
        }
    }

    class PathedWebSocketServer {
        wss: WebSocket.Server;
        path: string;
        name: string;

        constructor(mainWss: PathedWebSocketServer, path: string, name: string,
                    serverOptions = new WssOptions(
                        ws => {
                            ws.emit('message', new Blob([JSON.stringify(serverMessage('New Person Joined'))]));
                            notifyPathedWss(mainWss, new Blob([JSON.stringify(getPathedWssInfo(this))]));
                        },
                        ws => {
                            ws.emit('message', new Blob([JSON.stringify(serverMessage('Person Left'))]));
                            notifyPathedWss(mainWss, new Blob([JSON.stringify(getPathedWssInfo(this))]));
                        }
                    )) {
            this.path = path;
            this.name = name;
            this.wss = createServerlessWSS(serverOptions);
        }
    }
    //#endregion

    if (process.env.MONGO_URL === undefined) {
        console.log('MONGO_URL env variable is not set.');
        return;
    }

    console.log('connecting to db');
    await mongoose.connect(process.env.MONGO_URL);
    console.log('connected to db')

    const rooms = await Room.find({});
    console.log(rooms);

    const mainWss = new PathedWebSocketServer(this, '/', 'Main', new WssOptions(_ => {}, _ => {}));
    let wsRooms: PathedWebSocketServer[] = [];
    for (const room of rooms) {
        wsRooms.push(new PathedWebSocketServer(
            mainWss, `/room/${encodeURI(room.name.toLowerCase())}`, room.name
        ));
    }
    
    function notifyPathedWss(pathedWSS: PathedWebSocketServer, ...args) {
        for (const ws of pathedWSS.wss.clients) {
            ws.emit('message', ...args);
            break;
        }
    }
    
    //#region App & Server Initialization
    app.use(express.json());
    app.use(cors());
    
    app.post('/room', (req: Request, res: Response) => {
        const roomName = req.body.roomName;
        const roomPath = `/room/${encodeURI(roomName.toLowerCase())}`;
    
        for (const wss of wsRooms) {
            if (wss.path === roomPath) {
                res.status(400).json({ error: 'Room with same name already exists.' });
                return;
            }
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
                res.status(400).json({ 'error': 'Path given doesn\'t not exist.' });
            else
                res.json(getPathedWssInfo(room));
            return;
        }
    
        res.json({ rooms: getAllRooms() });
    });
    
    app.get('/room/:roomName', (req, res) => {
        const roomName = req.params.roomName;
        
        let roomWss: PathedWebSocketServer | null = null;
        for (const wss of wsRooms) {
            if (wss.name === roomName) {
                roomWss = wss;
                break;
            }
        }
    
        if (roomWss === null)
            res.status(400).json({ error: `Room ${roomName} does not exist.` });
        else
            res.json(getPathedWssInfo(roomWss));
    });
    
    function getAllRooms() {
        const rooms: any[] = [];
        wsRooms.forEach(wss => rooms.push(getPathedWssInfo(wss)));
        return rooms;
    }
    
    function getRoomMatchingPath(path: string) {
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
        if (req.url === undefined) {
            socket.destroy();
            return;
        }
    
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
