// Loads admin-managed content and sends bookings to the server. The static page still works if the API is down.
(async()=>{
 const $=(s,r=document)=>r.querySelector(s),f=$('#bf');
 document.addEventListener('click',e=>{const a=e.target.closest('[data-dj]');if(a&&f){if(f.elements.s)f.elements.s.value='DJ Booking';if(f.elements.dj)f.elements.dj.value=a.dataset.dj}});
 if(f){const hp=document.createElement('input');hp.name='web';hp.tabIndex=-1;hp.autocomplete='off';hp.style.cssText='position:absolute;left:-9999px';f.append(hp);
  f.addEventListener('submit',()=>{const d=new FormData(f);fetch('/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,body:JSON.stringify(Object.fromEntries(d))}).catch(()=>{})})}
 try{const {settings:s,gear,djs,mixtapes,events}=await (await fetch('/api/content')).json();
  if(s.tagline)$('.hero p').textContent=s.tagline;
  const setLast=(a,t)=>{a.lastChild.nodeType===3?a.lastChild.nodeValue=t:a.append(t)};
  if(s.phone)document.querySelectorAll('a[href^="tel:"]').forEach(a=>{a.href='tel:'+s.phone.replace(/[^\d+]/g,'');setLast(a,s.phone)});
  if(s.email)document.querySelectorAll('a[href^="mailto:"]').forEach(a=>{a.href='mailto:'+s.email;setLast(a,s.email)});
  if(s.whatsapp)document.querySelectorAll('a[href*="wa.me/"]').forEach(a=>a.href=a.href.replace(/wa\.me\/\d+/,'wa.me/'+s.whatsapp));
  if(s.address)$('.info li:nth-child(3) span').textContent=s.address;
  if(s.hours)$('.info li:nth-child(4) span').textContent=s.hours;
  ['instagram','youtube','tiktok','facebook'].forEach(k=>document.querySelectorAll('[data-k="'+k+'"]').forEach(a=>{s[k]?(a.href=s[k],a.target='_blank',a.rel='noopener'):a.remove()}));
  const grid=$('#hire .grid3'),ico=$('#hire .gear .ico')?.outerHTML||'';
  if(grid&&gear.length){grid.replaceChildren(...gear.filter(g=>g.available).map(g=>{const d=document.createElement('div');d.className='gear';d.innerHTML=ico;
   const w=document.createElement('div'),h=document.createElement('h3'),p=document.createElement('p');h.textContent=g.name;p.textContent=g.description+(g.price?' — '+g.price:'');w.append(h,p);d.append(w);return d}))}
 const ini=n=>{const w=n.replace(/\b(deejay|dj)\b/ig,'').trim().split(/\s+/).filter(Boolean);return(w.length>1?w.slice(0,2).map(x=>x[0]).join(''):(w[0]||n).slice(0,2)).toUpperCase()},L=(djs||[]).filter(d=>d.available),dg=$('#djgrid'),mk=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x)e.textContent=x;return e};
  if(dg&&L.length){dg.replaceChildren(...L.map(d=>{const a=mk('article','dj'),v=mk('div','av');if(d.photo){const i=new Image();i.src=d.photo;i.alt=d.name;v.append(i)}else v.textContent=ini(d.name);a.append(v,mk('h3','',d.name));if(d.realName)a.append(mk('small','real',d.realName));a.append(mk('span','',d.title));if(d.bio)a.append(mk('p','',d.bio));const b=mk('a','btn','Book '+d.name);b.href='#book';b.dataset.dj=d.name;a.append(b);const sp=mk('a','btn o','Profile & Store');sp.href='/store/#'+d.id;a.append(sp);return a}));
   if(f&&f.elements.dj)f.elements.dj.replaceChildren(new Option('Any DJ / no preference',''),...L.map(d=>new Option(d.name,d.name)))}
  window.CY_WA=s.whatsapp||'256703046409';
  const eg=$('#evgrid');
  if(eg&&Array.isArray(events)&&events.length){const wa=t=>'https://wa.me/'+(s.whatsapp||'256703046409')+'?text='+encodeURIComponent(t),
   fmt=d=>{const[y,m,dd]=d.split('-').map(Number),t=new Date(Date.UTC(y,m-1,dd));return{day:dd,mon:t.toLocaleDateString('en-GB',{month:'short',timeZone:'UTC'}),full:t.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'})}};
   eg.replaceChildren(...events.map(x=>{const off=x.status==='cancelled',c=mk('article','ev'+(off?' off':'')),m=mk('div','ev-media');
    if(x.image){const i=new Image();i.src=x.image;i.alt=x.title;i.loading='lazy';m.append(i)}else m.append(mk('div','ev-ph','Cyber Entertainment'));
    const dt=x.date?fmt(x.date):null,db=mk('div','ev-date'+(dt?'':' tba'));if(dt){db.append(mk('b','',dt.day),mk('span','',dt.mon))}else{db.append(mk('b','','Date TBA'))}m.append(db);
    if(x.status&&x.status!=='upcoming'){const bd=mk('span','ev-badge'+(x.status==='postponed'?' pp':''),x.status==='soldout'?'Sold out':x.status==='postponed'?'Postponed':'Cancelled');m.append(bd)}
    const b=mk('div','ev-body');b.append(mk('h3','',x.title));
    const ml=mk('ul','ev-meta');if(dt)ml.append(mk('li','',dt.full));else ml.append(mk('li','','Date to be announced'));if(x.time)ml.append(mk('li','',x.time));if(x.venue)ml.append(mk('li','',x.venue));b.append(ml);
    if(x.lineup)b.append(mk('div','ev-line','🎧 '+x.lineup));if(x.description)b.append(mk('p','ev-desc',x.description));
    const ft=mk('div','ev-foot');if(x.price)ft.append(mk('span','ev-price',x.price));
    if(!off){let a;if(x.status==='upcoming'&&x.ticketUrl){a=mk('a','btn','Get tickets');a.href=x.ticketUrl}
     else{a=mk('a','btn',x.status==='soldout'?'Ask about waitlist':x.status==='postponed'?'Ask for updates':'Ask about this event');a.href=wa('Hi Cyber Entertainment! I\'d like to know more about "'+x.title+'"'+(dt?' on '+dt.full:'')+'.')}
     a.target='_blank';a.rel='noopener';ft.append(a)}
    b.append(ft);c.append(m,b);return c}))}
  const mx=$('#mixroot');
  if(mx&&L.length){const av=d=>{const v=mk('div','av');if(d.photo){const i=new Image();i.src=d.photo;i.alt=d.name;v.append(i)}else v.textContent=ini(d.name);return v};
   mx.replaceChildren(...L.map(d=>{const its=(mixtapes||[]).filter(x=>x.djId===d.id),sec=mk('div','mxs'),hd=mk('div','mxh'),t=document.createElement('div');t.append(mk('h3','',d.name),mk('small','',its.length?its.length+(its.length>1?' mixtapes':' mixtape'):'Coming soon'));hd.append(av(d),t);sec.append(hd);sec.id='mix-'+d.id;
    if(!its.length)sec.append(mk('p','soon','New mixtapes from '+d.name+' are coming soon.'));
    else{const g=mk('div','mxg');its.forEach(x=>{const c=mk('div','mx');c.append(mk('h4','',x.title));
     if(x.stream){const a=document.createElement('audio');a.controls=true;a.preload='none';a.src=x.stream;c.append(a);const b=mk('a','btn','⬇ Download');b.href='/api/mixtapes/'+x.id+'/download';b.setAttribute('download','');c.append(b)}
     else{const b=mk('a','btn','▶ Listen');b.href=x.link;b.target='_blank';b.rel='noopener';c.append(b)}g.append(c)});sec.append(g)}
    return sec}))}
 }catch{}
 document.addEventListener('play',e=>document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()}),true);
})();
