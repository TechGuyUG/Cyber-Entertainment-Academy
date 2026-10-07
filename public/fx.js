// Scroll effects: progress bar, sticky-header shrink, hero depth, scroll-spy nav, reveal-on-scroll, back-to-top.
(()=>{
 const rm=matchMedia('(prefers-reduced-motion: reduce)').matches,$=(s,r=document)=>r.querySelector(s),all=(s,r=document)=>[...r.querySelectorAll(s)],pend=new Set();let show=null;
 const pg=document.createElement('div');pg.id='pg';pg.setAttribute('aria-hidden','true');
 const up=document.createElement('a');up.id='up';up.href='#top';up.setAttribute('aria-label','Back to top');up.textContent='↑';document.body.append(pg,up);
 const hd=$('header'),hero=$('.hero');let tick=false;
 const onScroll=()=>{tick=false;const y=scrollY,h=document.documentElement.scrollHeight-innerHeight;
  pg.style.transform='scaleX('+(h>0?Math.min(y/h,1):0)+')';hd&&hd.classList.toggle('sc',y>60);up.classList.toggle('show',y>700);
  if(hero&&!rm&&y<innerHeight*1.2)hero.style.setProperty('--py',y);
  if(show&&pend.size)pend.forEach(el=>{if(el.getBoundingClientRect().bottom<80)show(el)})};
 addEventListener('scroll',()=>{if(!tick){tick=true;requestAnimationFrame(onScroll)}},{passive:true});onScroll();
 if(!('IntersectionObserver'in window))return;
 const links=new Map(all('nav a[href^="#"]').map(a=>[a.getAttribute('href').slice(1),a]));
 const spy=new IntersectionObserver(es=>es.forEach(e=>{if(!e.isIntersecting)return;links.forEach(a=>a.classList.remove('on'));const a=links.get(e.target.dataset.spy||e.target.id);a&&a.classList.add('on')}),{rootMargin:'-35% 0px -60% 0px'});
 links.forEach((_,id)=>{const s=document.getElementById(id);s&&spy.observe(s)});
 [['.split','services'],['.cta','book']].forEach(([s,k])=>{const n=$(s);if(n){n.dataset.spy=k;spy.observe(n)}});
 if(rm)return;
 const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)show(e.target)}),{threshold:.12,rootMargin:'0px 0px -6% 0px'});
 show=el=>{if(!pend.delete(el))return;io.unobserve(el);el.classList.add('in');setTimeout(()=>el.classList.remove('rv','in','l','r'),1100+(+el.style.getPropertyValue('--i')||0)*90)};
 const mark=(el,dir)=>{if(el.dataset.rvd)return;el.dataset.rvd=1;pend.add(el);el.style.setProperty('--i',Math.min([...el.parentElement.children].indexOf(el),6));el.classList.add('rv');dir&&el.classList.add(dir);io.observe(el)};
 all('.card,.dj,.gear,.steps>div,details,.sched,form,.tags,.info li,.lead,.sec h2,.split h2,.cta .wrap>*').forEach(el=>mark(el));
 all('.split .pic').forEach(el=>mark(el,'l'));all('.split .g>div:last-child>*:not(h2)').forEach(el=>mark(el,'r'));
 ['#djgrid','#hire .grid3','#mixroot','#evgrid'].forEach(s=>{const c=$(s);c&&new MutationObserver(()=>[...c.children].forEach(x=>mark(x))).observe(c,{childList:true})});
})();
