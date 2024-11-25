import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import WebSocket, { WebSocketServer, RawData } from 'ws';

import Room from '../models/Room.model.js';
import Message from '../models/Message.model.js';

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

    function getPathedWssInfo(pathedWSS: PathedWebSocketServer) {
        return {
            name: pathedWSS.name,
            uri: pathedWSS.uri,
            numPeople: pathedWSS.wss.clients.size
        };
    }

    function createServerlessWSS(wssOptions: WssOptions, isMainWSS = false): WebSocketServer {
        const wss = new WebSocketServer({ noServer: true });
        wss.on('connection', ws => {
            ws.on('error', (e) => console.log(e));

            ws.on('close', () => wssOptions.leaveAction(ws));

            ws.on('message', (msg: Buffer) => {
                // only saving msg if not main WSS b/c
                // main WSS gets messages about server creation
                if (!isMainWSS)
                    Message.create({ message: msg.toString() });

                wss.clients.forEach(client => {
                    const isReady = client.readyState === WebSocket.OPEN;
                    if (isReady) {
                        if (wssOptions.shouldSendToBroadcaster || ws !== client)
                            client.send(msg);
                    }
                });
            });

            wssOptions.joinAction(ws);
        });

        return wss;
    }

    class WssOptions {
        joinAction: (ws: WebSocket) => void;
        leaveAction: (ws: WebSocket) => void;
        shouldSendToBroadcaster: boolean;

        constructor(joinAction: (ws: WebSocket) => void, leaveAction: (ws: WebSocket) => void,
                    shouldSendToBroadcaster = true) {
            this.joinAction = joinAction;
            this.leaveAction = leaveAction;
            this.shouldSendToBroadcaster = shouldSendToBroadcaster;
        }
    }

    class PathedWebSocketServer {
        wss: WebSocket.Server;
        uri: string;
        name: string;

        constructor(mainWss: PathedWebSocketServer, uri: string, name: string,
                    serverOptions = new WssOptions(
                        ws => {
                            ws.emit('message', Buffer.from(JSON.stringify(serverMessage('New Person Joined'))));
                            notifyPathedWss(mainWss, Buffer.from(JSON.stringify(getPathedWssInfo(this))));
                        },
                        ws => {
                            ws.emit('message', Buffer.from(JSON.stringify(serverMessage('Person Left'))));
                            notifyPathedWss(mainWss, Buffer.from(JSON.stringify(getPathedWssInfo(this))));
                        }
                    ), isMainWSS = false) {
            this.uri = uri;
            this.name = name;
            this.wss = createServerlessWSS(serverOptions, isMainWSS);
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
    const mainWss = new PathedWebSocketServer(this, '', 'Main', new WssOptions(_ => {}, _ => {}), true);
    let wsRooms: PathedWebSocketServer[] = [];
    for (const room of rooms) {
        wsRooms.push(new PathedWebSocketServer(
            mainWss, encodeURI(room.name.toLowerCase()), room.name
        ));
    }
    
    function notifyPathedWss(pathedWSS: PathedWebSocketServer, ...args: Buffer[]) {
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
        const roomPath = encodeURI(roomName.toLowerCase());
    
        for (const wss of wsRooms) {
            if (wss.uri === roomPath) {
                res.status(400).json({ error: 'A room with the same name already exists.', code: 'ROOM_DUPE' });
                return;
            }
        }

        Room.create({ name: roomName });
    
        const wss = new PathedWebSocketServer(mainWss, roomPath, roomName);
        wsRooms.push(wss);
    
        const wssInfo = getPathedWssInfo(wss);
        // notify about new room
        notifyPathedWss(mainWss, Buffer.from(JSON.stringify(wssInfo)));
    
        res.json(wssInfo);
    });
    
    app.get('/room', (req, res) => {
        res.json({ rooms: wsRooms.map(wss => getPathedWssInfo(wss)) });
    });
    
    app.get('/room/:roomUri', (req, res) => {
        const roomUri = encodeURI(req.params.roomUri);
        
        let roomWss: PathedWebSocketServer | null = null;
        for (const wss of wsRooms) {
            if (wss.uri === roomUri) {
                roomWss = wss;
                break;
            }
        }
    
        if (roomWss === null)
            res.status(404).json({ error: `Room "${roomUri}" does not exist.`});
        else
            res.json(getPathedWssInfo(roomWss));
    });
    
    const server = app.listen(4000, () => console.log('Go to http://localhost:4000'));
    //#endregion
    
    server.on('upgrade', (req, socket, head) => {
        if (req.url === undefined) {
            socket.destroy();
            return;
        }
    
        const reqUrl = new URL(`http://thisdoesntmatter.com${req.url}`);
        if (reqUrl.pathname === '/') {
            mainWss.wss.handleUpgrade(req, socket, head, ws => mainWss.wss.emit('connection', ws));
            return;
        }

        const splitPathname = reqUrl.pathname.split('/');
        let roomUri: string;
        if (splitPathname.length === 1)
            roomUri = splitPathname[0];
        else roomUri = splitPathname[splitPathname.length - 1];        
    
        for (const wss of wsRooms) {
            if (roomUri === wss.uri) {
                wss.wss.handleUpgrade(req, socket, head, ws => wss.wss.emit('connection', ws));
                return;
            }
        }
    
        console.log('Upgrade Failed\n');
        
        socket.destroy();
    });
}
