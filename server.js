'use strict';
// Cyber Entertainment — zero-dependency Node server (Node 18+). Static site + JSON API + admin.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{Readable}=require('stream');
const PORT=+process.env.PORT||3000,PUB=path.join(__dirname,'public'),DIR=path.join(__dirname,'data'),DB=path.join(DIR,'db.json');
fs.mkdirSync(DIR,{recursive:true});
const MEDIA=path.join(DIR,'media'),MAXMB=+process.env.MAX_UPLOAD_MB||300,MAXU=MAXMB*1048576,AUD=['.mp3','.m4a','.aac','.wav','.ogg'],AUDRE=/\.(mp3|m4a|aac|wav|ogg)(\?.*)?$/i;fs.mkdirSync(MEDIA,{recursive:true});
const USE_BLOB=process.env.VERCEL==='1'||!!process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_DB='cyber-entertainment/db.json';
let blobApiPromise;
const blobApi=()=>blobApiPromise||(blobApiPromise=import('@vercel/blob'));
const IMG=['.jpg','.jpeg','.png','.webp'],okImg=v=>/^https?:\/\//.test(v)||(/^\/media\/[\w.\-]+$/.test(v)&&fs.existsSync(path.join(MEDIA,v.slice(7))));
const G=n=>({id:crypto.randomUUID(),name:n,description:'Available for hire — message us for availability and rates.',price:'',available:true});
const DEF={settings:{tagline:'Great Vybz Nothingless',phone:'+256703046409',whatsapp:'256703046409',email:'academy@cyberentertainment.com',address:'Seguku Katale, Wankulukuku Road, Kampala',hours:'Mon – Fri 8 AM – 8 PM · Sat 8 AM – 2 PM',instagram:'',youtube:'',tiktok:'',facebook:''},
gear:['Controllers & Decks','Mixers','PA Speakers','Microphones','Stage Lighting','Effects & Extras'].map(G),bookings:[],events:[],admin:null,djs:[['Deejay Cyber G','Founder · Lead DJ'],['Deejay Tzo'],['Deejay Kaks'],['Jx Deejay'],['Mr Genius']].map(([n,t])=>({id:crypto.randomUUID(),name:n,title:t||'Cyber Entertainment DJ',bio:'',photo:'',available:true}))};
let db;
const localDb=()=>{try{return JSON.parse(fs.readFileSync(DB,'utf8'))}catch{return JSON.parse(JSON.stringify(DEF))}};
const saveLocal=()=>{fs.writeFileSync(DB+'.tmp',JSON.stringify(db,null,1));fs.renameSync(DB+'.tmp',DB)};
let saveChain=Promise.resolve();
const save=()=>{saveChain=saveChain.then(async()=>{
  if(USE_BLOB){
    const {put}=await blobApi();
    await put(BLOB_DB,JSON.stringify(db,null,1),{access:'private',allowOverwrite:true});
  }else saveLocal();
});return saveChain};
const migrateLocalMediaToBlob=async()=>{
  if(!USE_BLOB)return;
  const {put}=await blobApi(),seen=new Map();
  const fields=[...db.djs.map(x=>[x,'photo']),...db.shirts.map(x=>[x,'image']),...db.events.map(x=>[x,'image'])];
  for(const [obj,key] of fields){
    const v=obj[key];
    const m=typeof v==='string'&&v.match(/^\/media\/([\w.\-]+)$/);
    if(!m)continue;
    const fn=m[1],fp=path.join(MEDIA,fn);
    if(!fs.existsSync(fp))continue;
    let url=seen.get(fn);
    if(!url){
      const ext=path.extname(fn).toLowerCase();
      const blob=await put('media/'+fn,fs.readFileSync(fp),{access:'public',addRandomSuffix:false,contentType:MIME[ext]||'application/octet-stream'});
      url=blob.url;seen.set(fn,url);
    }
    obj[key]=url;
  }
};
const initDb=async()=>{
  if(USE_BLOB){
    const {get}=await blobApi();
    try{
      const {stream}=await get(BLOB_DB,{access:'private',useCache:false});
      db=JSON.parse(await new Response(stream).text());
    }catch{
      db=localDb();
      if(!db.admin){
        const pw=process.env.ADMIN_PASSWORD||crypto.randomBytes(9).toString('base64url');
        db.admin=hash(pw);
        console.log('=== FIRST RUN ===\\nAdmin URL: /admin\\nPassword : '+pw+'\\nChange it in Admin > Account.');
      }
      await save();
    }
  }else db=localDb();
  if(!db.djs)db.djs=DEF.djs;
  if(!db.mixtapes)db.mixtapes=[];
  if(!db.events)db.events=[];
  if(!db.shirts)db.shirts=db.djs.map(d=>({id:crypto.randomUUID(),djId:d.id,name:d.name+' Signature Tee',description:'Official Cyber Entertainment tee.',price:35000,sizes:'S,M,L,XL,XXL',image:'',available:true}));
  if(!db.admin){
    const pw=process.env.ADMIN_PASSWORD||crypto.randomBytes(9).toString('base64url');
    db.admin=hash(pw);
    console.log('\\n=== FIRST RUN ===\\nAdmin URL: /admin\\nPassword : '+pw+'\\nChange it in Admin > Account.\\n');
  }
  if(USE_BLOB){
    await migrateLocalMediaToBlob();
    await save();
  }else saveLocal();
};
// delete uploaded files no longer referenced by any mixtape, T-shirt or DJ photo (only if older than 1 hour)
const sweep=()=>{const k=new Set();db.mixtapes.forEach(x=>x.file&&k.add(x.file));[...db.shirts,...db.djs,...db.events].forEach(x=>{const m=(x.image||x.photo||'').match(/^\/media\/([\w.\-]+)$/);m&&k.add(m[1])});
 fs.readdirSync(MEDIA).forEach(f=>{try{if(!k.has(f)&&Date.now()-fs.statSync(path.join(MEDIA,f)).mtimeMs>36e5)fs.unlinkSync(path.join(MEDIA,f))}catch{}})};
const pub=x=>({id:x.id,djId:x.djId,title:x.title,stream:x.file?'/media/'+x.file:(AUDRE.test(x.url)?x.url:''),link:x.file||AUDRE.test(x.url)?'':x.url});
// Events: dates are plain YYYY-MM-DD (Kampala time, UTC+3). An empty date means "date to be announced".
const EVST=['upcoming','soldout','postponed','cancelled'],dateOk=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v+'T00:00:00Z'));
const today=()=>new Date(Date.now()+108e5).toISOString().slice(0,10);
const evSort=(a,b)=>(a.date?0:1)-(b.date?0:1)||a.date.localeCompare(b.date);
const pubEv=x=>({id:x.id,title:x.title,date:x.date,time:x.time,venue:x.venue,description:x.description,lineup:x.lineup,price:x.price,ticketUrl:x.ticketUrl,image:x.image,status:x.status});
const hash=(pw,salt=crypto.randomBytes(16).toString('hex'))=>salt+':'+crypto.scryptSync(pw,salt,64).toString('hex');
const check=(pw,h)=>{const[s,k]=h.split(':');return crypto.timingSafeEqual(Buffer.from(k,'hex'),crypto.scryptSync(pw,s,64))};
const sessions=new Map(),hits=new Map();
const limited=(k,max,ms)=>{const n=Date.now(),a=(hits.get(k)||[]).filter(t=>n-t<ms);a.push(n);hits.set(k,a);return a.length>max};
const send=(r,c,o,h={})=>{r.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store',...h});r.end(JSON.stringify(o))};
const body=q=>new Promise((ok,no)=>{let d='';q.on('data',c=>{d+=c;if(d.length>1e5){no();q.destroy()}});q.on('end',()=>{try{ok(JSON.parse(d||'{}'))}catch{no()}})});
const s=(v,n)=>String(v??'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,n);
const sid=q=>((q.headers.cookie||'').match(/cy_sid=([\w-]+)/)||[])[1];
const authed=q=>{const t=sid(q),e=t&&sessions.get(t);return e&&e>Date.now()};
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain','.xml':'application/xml','.webp':'image/webp','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.wav':'audio/wav','.ogg':'audio/ogg'};
const ready=initDb();
const SEC={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin'};
async function api(q,r,u){
 await ready;
 const ip=q.headers['x-forwarded-for']?.split(',')[0].trim()||q.socket.remoteAddress,m=q.method,p=u.pathname;
 if(m==='GET'&&p==='/api/content')return send(r,200,{settings:db.settings,gear:db.gear,djs:db.djs,shirts:db.shirts.filter(x=>x.available),mixtapes:db.mixtapes.filter(x=>x.available).map(pub),events:db.events.filter(x=>x.available&&(!x.date||x.date>=today())).sort(evSort).map(pubEv)});
 const dm=p.match(/^\/api\/mixtapes\/([\w-]+)\/download$/);
 if(m==='GET'&&dm){const x=db.mixtapes.find(y=>y.id===dm[1]&&y.available);if(!x)return send(r,404,{error:'Not found'});x.downloads=(x.downloads||0)+1;await save();r.writeHead(302,{Location:x.file?'/media/'+x.file+'?dl=1':x.url});return r.end()}
 if(m==='POST'&&p==='/api/bookings'){
  if(limited('b'+ip,5,6e5))return send(r,429,{error:'Too many requests, try later.'});
  const b=await body(q);if(b.web)return send(r,200,{ok:true}); // honeypot
  const x={id:crypto.randomUUID(),created:new Date().toISOString(),name:s(b.n,80),phone:s(b.p,30),service:s(b.s,40),dj:s(b.dj,80),date:s(b.d,10),venue:s(b.v,120),message:s(b.m,1000),status:'new',note:''};
  if(!x.name||!x.phone)return send(r,400,{error:'Name and phone are required.'});
  db.bookings.unshift(x);db.bookings=db.bookings.slice(0,5000);await save();return send(r,201,{ok:true});}
 if(m==='POST'&&p==='/api/login'){
  if(limited('l'+ip,8,9e5))return send(r,429,{error:'Too many attempts. Wait 15 minutes.'});
  const b=await body(q);if(!check(String(b.password||''),db.admin))return send(r,401,{error:'Wrong password.'});
  const t=crypto.randomBytes(24).toString('hex');sessions.set(t,Date.now()+288e5);
  const sec=(process.env.COOKIE_SECURE==='1'||q.headers['x-forwarded-proto']==='https')?'; Secure':'';
  return send(r,200,{ok:true},{'Set-Cookie':`cy_sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${sec}`});}
 if(!p.startsWith('/api/admin/')&&p!=='/api/logout')return send(r,404,{error:'Not found'});
 if(!authed(q))return send(r,401,{error:'Login required'});
 if(m!=='GET'&&q.headers['x-requested-with']!=='admin')return send(r,403,{error:'Bad request'});
 if(p==='/api/logout'){sessions.delete(sid(q));return send(r,200,{ok:true},{'Set-Cookie':'cy_sid=; Max-Age=0; Path=/'})}
 if(m==='GET'&&p==='/api/admin/data')return send(r,200,{settings:db.settings,gear:db.gear,djs:db.djs,shirts:db.shirts,mixtapes:db.mixtapes,events:db.events,bookings:db.bookings});
 if(m==='GET'&&p==='/api/admin/bookings.csv'){
  const c=v=>'"'+String(v).replace(/"/g,'""').replace(/^([=+\-@])/,"'$1")+'"',k=['created','name','phone','service','dj','date','venue','message','status','note'];
  r.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':'attachment; filename=bookings.csv'});
  return r.end([k.join(',')].concat(db.bookings.map(b=>k.map(x=>c(b[x])).join(','))).join('\n'));}
 const bm=p.match(/^\/api\/admin\/bookings\/([\w-]+)$/);
 if(bm){const i=db.bookings.findIndex(x=>x.id===bm[1]);if(i<0)return send(r,404,{error:'Not found'});
  if(m==='DELETE'){db.bookings.splice(i,1);await save();return send(r,200,{ok:true})}
  if(m==='PATCH'){const b=await body(q);if(['new','contacted','confirmed','done','cancelled'].includes(b.status))db.bookings[i].status=b.status;if('note'in b)db.bookings[i].note=s(b.note,500);await save();return send(r,200,db.bookings[i])}}
 if(m==='PUT'&&p==='/api/admin/settings'){const b=await body(q);for(const k of Object.keys(DEF.settings))if(k in b)db.settings[k]=s(b[k],200);
  db.settings.whatsapp=db.settings.whatsapp.replace(/\D/g,'');await save();return send(r,200,db.settings)}
 if(m==='PUT'&&p==='/api/admin/gear'){const b=await body(q);if(!Array.isArray(b.gear))return send(r,400,{error:'Bad data'});
  db.gear=b.gear.slice(0,100).map(g=>({id:/^[\w-]{1,40}$/.test(g.id)?g.id:crypto.randomUUID(),name:s(g.name,80)||'Untitled',description:s(g.description,300),price:s(g.price,40),available:!!g.available}));await save();return send(r,200,db.gear)}
 if(m==='PUT'&&p==='/api/admin/djs'){const b=await body(q);if(!Array.isArray(b.djs))return send(r,400,{error:'Bad data'});
  const web=v=>/^https?:\/\//.test(v)?v:'';
  db.djs=b.djs.slice(0,50).map(d=>({id:/^[\w-]{1,40}$/.test(d.id)?d.id:crypto.randomUUID(),name:s(d.name,60)||'Untitled DJ',realName:s(d.realName,60),title:s(d.title,60),bio:s(d.bio,600),genres:s(d.genres,100),instagram:web(s(d.instagram,300)),photo:okImg(s(d.photo,300))?s(d.photo,300):'',available:!!d.available}));await save();sweep();return send(r,200,db.djs)}
 if(m==='PUT'&&p==='/api/admin/shirts'){const b=await body(q);if(!Array.isArray(b.shirts))return send(r,400,{error:'Bad data'});const ids=new Set(db.djs.map(d=>d.id));
  db.shirts=b.shirts.slice(0,300).filter(x=>ids.has(x.djId)).map(x=>({id:/^[\w-]{1,40}$/.test(x.id)?x.id:crypto.randomUUID(),djId:x.djId,name:s(x.name,80)||'Untitled tee',description:s(x.description,300),price:Math.max(0,Math.round(+x.price)||0),sizes:s(x.sizes,60)||'S,M,L,XL',image:okImg(s(x.image,300))?s(x.image,300):'',available:!!x.available}));await save();sweep();return send(r,200,db.shirts)}
 if(m==='PUT'&&p==='/api/admin/events'){const b=await body(q);if(!Array.isArray(b.events))return send(r,400,{error:'Bad data'});
  const web=v=>/^https?:\/\//.test(v)?v:'';
  db.events=b.events.slice(0,300).map(x=>{const d=s(x.date,10);return{id:/^[\w-]{1,40}$/.test(x.id)?x.id:crypto.randomUUID(),title:s(x.title,100)||'Untitled event',date:dateOk(d)?d:'',time:s(x.time,30),venue:s(x.venue,120),description:s(x.description,600),lineup:s(x.lineup,200),price:s(x.price,60),ticketUrl:web(s(x.ticketUrl,300)),image:okImg(s(x.image,300))?s(x.image,300):'',status:EVST.includes(x.status)?x.status:'upcoming',available:!!x.available}});
  await save();sweep();return send(r,200,db.events)}
 if(m==='POST'&&p==='/api/admin/upload'){
  const name=s(u.searchParams.get('name'),100).replace(/[^\w.\-]+/g,'_'),len=+q.headers['content-length']||0;
  const ext=path.extname(name).toLowerCase(),lim=IMG.includes(ext)?8388608:MAXU;
  if(lim===MAXU&&!AUD.includes(ext))return send(r,400,{error:'Use an mp3, m4a, aac, wav, ogg (audio) or jpg, png, webp (image) file.'});
  if(len>lim)return send(r,413,{error:'File too large (max '+(lim>>20)+' MB).'});
  const file=crypto.randomUUID()+'-'+name;
  if(USE_BLOB){
    // Vercel Functions should not write uploads to the local filesystem.
    // Images are stored in Blob and the returned public URL is saved in the DJ record.
    if(!IMG.includes(ext))return send(r,400,{error:'Audio uploads on Vercel should use a direct Blob upload or an external audio link. Image uploads are supported here.'});
    try{
      const {put}=await blobApi();
      const blob=await put('media/'+file,Readable.toWeb(q),{access:'public',addRandomSuffix:false,contentType:MIME[ext]||'application/octet-stream'});
      return send(r,201,{file:'',url:blob.url,size:len});
    }catch(e){return send(r,500,{error:'Upload failed: '+(e?.message||'Vercel Blob is not configured.')})}
  }
  const fp=path.join(MEDIA,file),ws=fs.createWriteStream(fp);let n=0,dead=false;
  q.on('data',c=>{n+=c.length;if(n>lim&&!dead){dead=true;ws.destroy();fs.unlink(fp,()=>{});send(r,413,{error:'File too large (max '+(lim>>20)+' MB).'});q.destroy()}});
  ws.on('finish',()=>{if(!dead)send(r,201,{file,size:n})});ws.on('error',()=>{if(!dead){dead=true;send(r,500,{error:'Upload failed'})}});q.pipe(ws);return}
 if(m==='PUT'&&p==='/api/admin/mixtapes'){const b=await body(q);if(!Array.isArray(b.mixtapes))return send(r,400,{error:'Bad data'});
  const old=new Map(db.mixtapes.map(x=>[x.id,x])),ids=new Set(db.djs.map(d=>d.id));
  db.mixtapes=b.mixtapes.slice(0,300).filter(x=>ids.has(x.djId)).map(x=>{const o=old.get(x.id),fn=s(x.file,200),u2=s(x.url,300);
   return{id:o?o.id:crypto.randomUUID(),djId:x.djId,title:s(x.title,100)||'Untitled mixtape',file:/^[\w.\-]+$/.test(fn)&&fs.existsSync(path.join(MEDIA,fn))?fn:'',url:/^https?:\/\//.test(u2)?u2:'',available:!!x.available,downloads:o?o.downloads||0:0,created:o?o.created:new Date().toISOString()}});
  await save();sweep();
  return send(r,200,db.mixtapes)}
 if(m==='POST'&&p==='/api/admin/password'){const b=await body(q);
  if(!check(String(b.current||''),db.admin))return send(r,400,{error:'Current password is wrong.'});
  if(String(b.next||'').length<10)return send(r,400,{error:'Use at least 10 characters.'});
  db.admin=hash(String(b.next));await save();sessions.clear();return send(r,200,{ok:true})}
 send(r,404,{error:'Not found'});}
function media(q,r,u){let f='';try{f=decodeURIComponent(u.pathname.slice(7))}catch{}
 if(!/^[\w.\-]+$/.test(f)){r.writeHead(404);return r.end('Not found')}
 const fp=path.join(MEDIA,f);fs.stat(fp,(e,st)=>{if(e||!st.isFile()){r.writeHead(404);return r.end('Not found')}
  const h={'Content-Type':MIME[path.extname(f).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'public, max-age=86400'};
  if(u.searchParams.get('dl'))h['Content-Disposition']='attachment; filename="'+f.slice(37)+'"';
  let a=0,b=st.size-1,c=200;const m=/bytes=(\d*)-(\d*)/.exec(q.headers.range||'');
  if(m&&(m[1]||m[2])){if(m[1]==='')a=Math.max(0,st.size-+m[2]);else{a=+m[1];if(m[2])b=Math.min(+m[2],b)}
   if(a>b||a>=st.size){r.writeHead(416,{'Content-Range':'bytes */'+st.size});return r.end()}c=206;h['Content-Range']='bytes '+a+'-'+b+'/'+st.size}
  h['Content-Length']=b-a+1;r.writeHead(c,h);if(q.method==='HEAD')return r.end();fs.createReadStream(fp,{start:a,end:b}).pipe(r)})}
const srv=http.createServer(async(q,r)=>{
 try{const u=new URL(q.url,'http://x');Object.entries(SEC).forEach(([k,v])=>r.setHeader(k,v));
  if(u.pathname.startsWith('/media/'))return media(q,r,u);
  if(u.pathname.startsWith('/api/'))return await api(q,r,u);
  let p=decodeURIComponent(u.pathname);if(p==='/admin'||p==='/store')p+='/';if(p.endsWith('/'))p+='index.html';
  const f=path.join(PUB,p);if(!f.startsWith(PUB+path.sep)||/(^|[\\/])\./.test(p)){r.writeHead(403);return r.end('Forbidden')}
  fs.readFile(f,(e,d)=>{if(e){r.writeHead(404,{'Content-Type':'text/html'});return r.end('<h1>404</h1><a href="/">Back home</a>')}
   r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','Cache-Control':p.startsWith('/admin')?'no-store':'public, max-age=300'});r.end(d)});
 }catch(e){console.error('Request error:',e);if(!r.headersSent)send(r,500,{error:'Server error'})}
}).listen(PORT,()=>console.log('Cyber Entertainment running on http://localhost:'+PORT));
srv.requestTimeout=18e5;
