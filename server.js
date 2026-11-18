'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'16kb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req,res)=>res.json({ok:true,rooms:rooms.size}));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods:['GET','POST'] },
  pingInterval: 25000, pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});
const db = new Database(path.join(__dirname,'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS friends(user_id TEXT NOT NULL, friend_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,friend_id));
`);
const qUser=db.prepare('SELECT id,username,pass_hash FROM users WHERE username=?');
const qId=db.prepare('SELECT id,username FROM users WHERE id=?');
const insertUser=db.prepare('INSERT INTO users(id,username,pass_hash,created_at) VALUES(?,?,?,?)');
const addFriend=db.prepare('INSERT OR IGNORE INTO friends(user_id,friend_id,created_at) VALUES(?,?,?)');
const getFriends=db.prepare('SELECT u.id,u.username FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=?');

const rooms = new Map(), online = new Map(), sessions = new Map(), invites = new Map();
const clean = (v,n=40)=>String(v??'').replace(/[<>]/g,'').trim().slice(0,n);
const roomCode=()=>crypto.randomBytes(4).toString('hex').toUpperCase();
const playerCode=()=>crypto.randomBytes(6).toString('hex').toUpperCase();
const fail=(s,msg)=>s.emit('room:error',{message:msg});
const profileFail=(s,msg)=>s.emit('profile:error',{message:msg});
function publicRooms(){return [...rooms.values()].filter(r=>!r.private).map(r=>({id:r.id,name:r.name,count:r.players.size,capacity:r.capacity,private:r.private}));}
function snapshot(r){return [...r.players.values()].map(p=>({id:p.id,username:p.username,bike:p.state.bike,x:p.state.x,z:p.state.z,hd:p.state.hd,speed:p.state.speed}));}
function roomBroadcast(r){io.to(r.id).emit('room:state',snapshot(r));}
function roomFor(s){const id=s.data.roomId;return id?rooms.get(id):null;}
function leave(s){
 const r=roomFor(s);if(!r)return;
 const p=r.players.get(s.data.playerId);r.players.delete(s.data.playerId);s.leave(r.id);s.data.roomId=null;
 if(r.host===s.data.playerId){r.host=r.players.keys().next().value||null;if(r.host)io.to(r.id).emit('room:host',{playerId:r.host});}
 s.emit('room:left');io.to(r.id).emit('player:left',{id:s.data.playerId,username:p?.username||'Player'});
 if(!r.players.size)rooms.delete(r.id);roomBroadcast(r);io.emit('rooms:list',publicRooms());
}
function tokenFor(id){return crypto.createHmac('sha256',process.env.TOKEN_SECRET||'change-this-secret-before-public-deploy').update(id).digest('hex');}
function authSession(s,token){
 if(!token)return null;
 for(const [id,t] of sessions)if(t===token){const u=qId.get(id);if(u){s.data.playerId=id;s.data.username=u.username;online.set(id,s.id);return u;}}
 return null;
}
io.on('connection',s=>{
 s.data.roomId=null;s.data.playerId=null;
 s.on('profile:register',async d=>{
  const username=clean(d?.username,20),password=String(d?.password||'');
  if(!/^[A-Za-z0-9_]{3,20}$/.test(username)||password.length<8)return profileFail(s,'Username: 3-20 letters/numbers/_. Password: at least 8 characters.');
  if(qUser.get(username))return profileFail(s,'Username already exists.');
  const id=playerCode(),hash=await bcrypt.hash(password,12);
  try{insertUser.run(id,username,hash,Date.now());sessions.set(id,tokenFor(id));s.data.playerId=id;s.data.username=username;online.set(id,s.id);s.emit('profile:ok',{id,username,token:sessions.get(id)});}
  catch(e){profileFail(s,'Could not create account. Try another username.');}
 });
 s.on('profile:login',async d=>{
  const username=clean(d?.username,20),u=qUser.get(username);
  if(!u||!(await bcrypt.compare(String(d?.password||''),u.pass_hash)))return profileFail(s,'Incorrect username or password.');
  const token=tokenFor(u.id);sessions.set(u.id,token);s.data.playerId=u.id;s.data.username=u.username;online.set(u.id,s.id);s.emit('profile:ok',{id:u.id,username:u.username,token});
 });
 s.on('profile:resume',token=>{const u=authSession(s,token);if(u)s.emit('profile:ok',{id:u.id,username:u.username,token});});
 s.on('rooms:list',()=>s.emit('rooms:list',publicRooms()));
 s.on('room:create',d=>{
  if(!s.data.playerId)return fail(s,'Login first.');
  const capacity=Math.max(2,Math.min(20,Number(d?.capacity)||20));
  const isPrivate=!!d?.private, password=String(d?.password||'');
  if(isPrivate&&password.length<4)return fail(s,'Private room password must be at least 4 characters.');
  if(roomFor(s))leave(s);
  let id=roomCode();while(rooms.has(id))id=roomCode();
  const r={id,name:clean(d?.name,32)||'Riders Room',private:isPrivate,passwordHash:isPrivate?bcrypt.hashSync(password,10):null,capacity,host:s.data.playerId,players:new Map()};
  rooms.set(id,r);joinRoom(s,r);io.emit('rooms:list',publicRooms());
 });
 function joinRoom(s,r){
  if(!s.data.playerId)return fail(s,'Login first.');
  if(r.players.size>=r.capacity)return fail(s,'Room is full.');
  if(roomFor(s))leave(s);
  const p={id:s.data.playerId,username:s.data.username,state:{x:0,z:0,hd:0,speed:0,bike:'duke'},lastState:0};
  r.players.set(p.id,p);s.data.roomId=r.id;s.join(r.id);
  s.emit('room:joined',{id:r.id,name:r.name,private:r.private,capacity:r.capacity,host:r.host});
  s.to(r.id).emit('player:joined',{id:p.id,username:p.username});roomBroadcast(r);io.emit('rooms:list',publicRooms());
 }
 s.on('room:join',d=>{
  const r=rooms.get(clean(d?.roomId,16).toUpperCase());
  if(!r)return fail(s,'Room not found.');
  if(r.private&&!bcrypt.compareSync(String(d?.password||''),r.passwordHash))return fail(s,'Wrong room password.');
  joinRoom(s,r);
 });
 s.on('room:leave',()=>leave(s));
 s.on('player:state',d=>{
  const r=roomFor(s),p=r?.players.get(s.data.playerId);if(!p||!d)return;
  const now=Date.now();if(now-p.lastState<45)return;p.lastState=now;
  const x=Number(d.x),z=Number(d.z),hd=Number(d.hd),speed=Number(d.speed);
  if(![x,z,hd,speed].every(Number.isFinite)||Math.abs(x)>500000||Math.abs(z)>500000||Math.abs(speed)>1000)return;
  // Basic server-side sanity limits; this is not a full authoritative physics engine.
  const old=p.state,dt=Math.max(.045,(now-(p.stateAt||now))/1000),distance=Math.hypot(x-old.x,z-old.z);
  if(p.stateAt&&distance>Math.max(45,Math.abs(old.speed)*dt/3.6+20))return;
  p.state={x,z,hd:Math.atan2(Math.sin(hd),Math.cos(hd)),speed:Math.max(0,Math.min(600,Math.abs(speed))),bike:/^[a-z0-9_]{2,24}$/i.test(d.bike||'')?d.bike:'duke'};p.stateAt=now;
  roomBroadcast(r);
 });
 s.on('chat:room',d=>{
  const r=roomFor(s),text=clean(d?.text,300);if(!r||!text)return;
  const now=Date.now();if(s.data.chatAt&&now-s.data.chatAt<700)return;s.data.chatAt=now;
  io.to(r.id).emit('chat:room',{id:s.data.playerId,username:s.data.username,text,at:now});
 });
 s.on('chat:private',d=>{
  const text=clean(d?.text,300),to=clean(d?.to,24),target=online.get(to);if(!text||!target)return;
  io.to(target).emit('chat:private',{id:s.data.playerId,username:s.data.username,text});
 });
 s.on('friends:add',d=>{
  const friend=qId.get(clean(d?.playerId,24).toUpperCase());
  if(!friend||friend.id===s.data.playerId)return s.emit('friend:result',{message:'Player ID not found.'});
  addFriend.run(s.data.playerId,friend.id,Date.now());s.emit('friend:result',{message:'Friend added.'});
 });
 s.on('friends:list',()=>{
  const friends=getFriends.all(s.data.playerId||'').map(f=>({...f,online:online.has(f.id)}));
  s.emit('friend:result',{message:'Friends',friends});
 });
 s.on('invite:send',d=>{
  const target=online.get(clean(d?.playerId,24)),r=roomFor(s);if(!target||!r)return fail(s,'Friend is offline or you are not in a room.');
  const inviteId=crypto.randomUUID();invites.set(inviteId,{from:s.data.username,roomId:r.id,to:target,expires:Date.now()+60000});
  io.to(target).emit('invite:received',{inviteId,from:s.data.username,roomId:r.id});
 });
 s.on('invite:respond',d=>{
  const i=invites.get(d?.inviteId);if(!i||i.to!==s.id||i.expires<Date.now())return;
  invites.delete(d.inviteId);if(d.accept){const r=rooms.get(i.roomId);if(r)joinRoom(s,r);}
 });
 s.on('race:start',d=>{
  const r=roomFor(s);if(!r||r.host!==s.data.playerId)return fail(s,'Only the room host can start a race.');
  const start={x:Number(d?.start?.x)||0,z:Number(d?.start?.z)||0},finish={x:Number(d?.finish?.x)||0,z:Number(d?.finish?.z)||-500};
  io.to(r.id).emit('race:countdown',{seconds:3,start,finish});setTimeout(()=>io.to(r.id).emit('race:result',{message:'Race started. Finish timing is client-side in this starter release.'}),3000);
 });
 s.on('room:kick',d=>{const r=roomFor(s);if(!r||r.host!==s.data.playerId)return;const target=r.players.get(clean(d?.playerId,24));if(!target)return;const sid=online.get(target.id);if(sid){const ts=io.sockets.sockets.get(sid);if(ts){leave(ts);ts.emit('room:error',{message:'You were removed by the room host.'});}}});
 s.on('room:transfer',d=>{const r=roomFor(s),id=clean(d?.playerId,24);if(r&&r.host===s.data.playerId&&r.players.has(id)){r.host=id;io.to(r.id).emit('room:host',{playerId:id});}});
 s.on('disconnect',()=>{leave(s);if(s.data.playerId&&online.get(s.data.playerId)===s.id)online.delete(s.data.playerId);});
});
function lanAddresses(){const out=[];for(const list of Object.values(os.networkInterfaces()))for(const n of list||[])if(n.family==='IPv4'&&!n.internal)out.push(n.address);return out;}
server.listen(PORT,HOST,()=>{console.log(`OWMS server listening on ${HOST}:${PORT}`);console.log('LAN addresses:',lanAddresses().map(ip=>`http://${ip}:${PORT}`).join('  ')||'none detected');});
