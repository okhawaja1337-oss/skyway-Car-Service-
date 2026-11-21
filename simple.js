/* ===================================================================
   simple.js — Simple Mode shell for the Skyway dispatcher console
   (design doc section 2).  Loaded last, after index.html's app script.

   - Six big section buttons: TODAY · BOOK · BOARD · DRIVERS · MONEY · SETTINGS
   - No DOM re-parenting: sections map onto existing views via goTab();
     TODAY/BOOK/BOARD are all view 'dispatch' with body.dataset.simpleMode
     driving simple.css.
   - Needs-You strip, first-run checklist, 10-second Undo, Expert-mode
     toggle, printable cheat sheet, optional 4-digit admin PIN.
   - Monkey-patches globals (goTab, refreshBoard, assignDriver, bestAssign,
     cancelTrip, noShowTrip, cycleStatus, optAssignOne, optApplyAll,
     diqAssign, editTrip, newTrip) via window.fn = wrapper.  index.html is
     never edited.
   - Skipped entirely inside pop-out windows (?screen=NAME sets SCREEN).

   Public API: window.Simple = { enter(section), refreshNeedsYou(),
                                 undoable(label, fn, ids?), setExpert(bool) }
   =================================================================== */
(function(){
  'use strict';
  if(typeof STATE==='undefined')return;
  /* pop-out screens: SCREEN is a top-level const in index.html (not on window) */
  var screenName='';
  try{screenName=(typeof SCREEN!=='undefined'&&SCREEN)||window.SCREEN||'';}catch(e){screenName=window.SCREEN||'';}
  if(typeof screenName==='string'&&screenName)return;
  if(window.Simple&&window.Simple._loaded)return;

  var $=function(id){return document.getElementById(id);};
  var S=function(){STATE.settings=STATE.settings||{};return STATE.settings;};
  function g(name){return typeof window[name]==='function'?window[name]:null;}
  function call(name){var f=g(name);if(!f)return undefined;try{return f.apply(null,Array.prototype.slice.call(arguments,1));}catch(e){console.warn('simple.js: '+name+' failed',e);}}
  function doSave(){if(g('save'))window.save();}
  function say(m,w){if(g('toast'))window.toast(m,w);}
  function escH(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function fmtMoney(n){return g('money')?window.money(n):('$'+(Number(n)||0).toFixed(2));}
  function trip(id){return (STATE.trips||[]).find(function(x){return x.id===id;});}
  function h12(t){t=String(t||'').trim();var m=t.match(/^(\d{1,2}):(\d{2})/);if(!m)return t||'ASAP';var h=+m[1],mi=m[2];var ap=h>=12?'pm':'am';h=h%12;if(h===0)h=12;return h+':'+mi+ap;}
  function pickup(t){if(g('pickupDT')){try{return window.pickupDT(t);}catch(e){}}if(!t||!t.date)return null;var p=t.date.split('-').map(Number),tp=(t.time||'0:0').split(':');return new Date(p[0],p[1]-1,p[2],+tp[0]||0,+tp[1]||0,0);}
  function dispatchedAt(t){if(!t.date)return null;if(t.dispTime){var p=t.date.split('-').map(Number),tp=String(t.dispTime).split(':');var d=new Date(p[0],p[1]-1,p[2],+tp[0]||0,+tp[1]||0,0);if(!isNaN(d))return d;}return pickup(t);}
  function currentView(){
    if(typeof ACTIVE_VIEW!=='undefined'&&ACTIVE_VIEW)return ACTIVE_VIEW;
    var a=document.querySelector('.view.active');return a?a.id.replace(/^view-/,''):'dispatch';
  }
  function isSimple(){var s=S();return s.simpleMode!==false&&!s.expertMode;}
  function dispatchMode(){return document.body.dataset.simpleMode||'';}

  /* ---------------- sections ---------------- */
  var SECTIONS=[
    {id:'today',   label:'Today',   ic:'☀', view:'dispatch', mode:'today'},
    {id:'book',    label:'Book',    ic:'✚', view:'dispatch', mode:'book'},
    {id:'board',   label:'Board',   ic:'☰', view:'dispatch', mode:'board',
      sub:[['Board','dispatch'],['Trips','trips'],['Call history','history'],['Trip map','map']]},
    {id:'drivers', label:'Drivers', ic:'⚑', view:'fleet',
      sub:[['Fleet','fleet'],['Driver IQ','driveriq'],['Optimizer','optimizer'],['Zone map','zonemap']]},
    {id:'money',   label:'Money',   ic:'$',      view:'earnings',
      sub:[['Earnings','earnings'],['Accounts','accounts'],['Invoices','invoicing'],['Business','biz'],['TLC export','tlc']]},
    {id:'settings',label:'Settings',ic:'⚙', view:'settings',
      sub:[['Settings','settings'],['Rates & zones','pricing'],['Address book','addrbook'],['Fare estimate','estimate']]}
  ];
  var VIEW_SECTION={dispatch:'today',trips:'board',history:'board',map:'board',
    fleet:'drivers',driveriq:'drivers',optimizer:'drivers',zonemap:'drivers',
    earnings:'money',accounts:'money',invoicing:'money',biz:'money',tlc:'money',
    settings:'settings',pricing:'settings',addrbook:'settings',estimate:'settings'};
  function sectionById(id){for(var i=0;i<SECTIONS.length;i++)if(SECTIONS[i].id===id)return SECTIONS[i];return null;}
  function sectionForView(v){
    if(v==='dispatch'){var m=dispatchMode();return (m==='book'||m==='board')?m:'today';}
    return VIEW_SECTION[v]||null;
  }

  /* ---------------- PIN ---------------- */
  var pinUnlocked=false;
  function pinOK(){
    var pin=String(S().adminPin||'').trim();
    if(!/^\d{4}$/.test(pin))return true;
    if(pinUnlocked)return true;
    var a=null;
    try{a=window.prompt('Enter the 4-digit admin PIN to open Settings:','');}catch(e){a=null;}
    if(a===null)return false;
    if(String(a).trim()===pin){pinUnlocked=true;return true;}
    say('Wrong PIN.',true);return false;
  }

  /* ---------------- section bar ---------------- */
  function buildBar(){
    if($('simpleBar'))return;
    var bar=document.createElement('div');bar.id='simpleBar';
    var row=document.createElement('div');row.className='sb-row';
    SECTIONS.forEach(function(s){
      var b=document.createElement('button');b.type='button';b.className='sb-btn';b.dataset.section=s.id;
      b.innerHTML='<span class="ic">'+escH(s.ic)+'</span><span>'+escH(s.label)+'</span>';
      b.title=s.label;
      b.addEventListener('click',function(){enter(s.id);});
      row.appendChild(b);
    });
    var aux=document.createElement('div');aux.className='sb-aux';
    var help=document.createElement('button');help.type='button';help.className='sb-help';help.id='sbHelp';help.textContent='?';help.title='Help — how to use this (F1)';
    help.addEventListener('click',function(){if(g('toggleHelp'))window.toggleHelp(true);else say('Help: Today = book & assign. Board = every live trip. Settings → Print cheat sheet.');});
    var ex=document.createElement('button');ex.type='button';ex.className='sb-expert';ex.id='sbExpert';ex.textContent='Expert mode';ex.title='Show the original 17-tab bar';
    ex.addEventListener('click',function(){if(!pinOK())return;setExpert(true);});
    aux.appendChild(help);aux.appendChild(ex);row.appendChild(aux);
    bar.appendChild(row);
    var sub=document.createElement('div');sub.className='sb-sub';sub.id='simpleSub';sub.hidden=true;bar.appendChild(sub);
    var pad=document.createElement('div');pad.className='sb-pad';pad.id='simplePad';bar.appendChild(pad);
    var tabs=$('tabs');
    if(tabs&&tabs.parentNode)tabs.parentNode.insertBefore(bar,tabs);
    else{var cmd=document.querySelector('.cmdbar');if(cmd&&cmd.parentNode)cmd.parentNode.insertBefore(bar,cmd.nextSibling);else document.body.insertBefore(bar,document.body.firstChild);}
    /* "back to simple" button inside the original tab bar for expert mode */
    if(tabs&&!$('sbReturn')){
      var ret=document.createElement('button');ret.type='button';ret.id='sbReturn';ret.className='sb-return';ret.textContent='◀ Simple mode';ret.title='Back to the six big buttons';
      ret.addEventListener('click',function(e){e.stopPropagation();setExpert(false);});
      tabs.appendChild(ret);
    }
  }
  function syncHighlight(){
    var bar=$('simpleBar');if(!bar)return;
    var v=currentView(),sec=sectionForView(v);
    bar.querySelectorAll('.sb-btn').forEach(function(b){b.classList.toggle('active',b.dataset.section===sec);});
    var sub=$('simpleSub');if(!sub)return;
    var s=sectionById(sec);
    if(!s||!s.sub){sub.hidden=true;sub.innerHTML='';var pad=$('simplePad');if(pad)pad.hidden=false;return;}
    var padEl=$('simplePad');if(padEl)padEl.hidden=true;
    var key=s.id;
    if(sub.dataset.sec!==key){
      sub.innerHTML='<span class="sb-sublbl">'+escH(s.label)+'</span>';
      s.sub.forEach(function(p){
        var b=document.createElement('button');b.type='button';b.className='sb-subbtn';b.dataset.view=p[1];b.textContent=p[0];
        b.addEventListener('click',function(){enter(s.id,p[1]);});
        sub.appendChild(b);
      });
      sub.dataset.sec=key;
    }
    sub.querySelectorAll('.sb-subbtn').forEach(function(b){b.classList.toggle('active',b.dataset.view===v);});
    sub.hidden=false;
  }
  function enter(sectionId,view){
    var s=sectionById(sectionId);if(!s)return false;
    if(s.id==='settings'&&!pinOK())return false;
    if(s.mode)document.body.dataset.simpleMode=s.mode;
    var v=view||s.view;
    if(!$('view-'+v))v=s.view;
    if(!$('view-'+v))return false;
    if(g('goTab'))window.goTab(v);
    if(v==='dispatch'){refreshNeedsYou();renderChecklist();}
    syncHighlight();
    try{window.scrollTo(0,0);}catch(e){}
    return true;
  }

  /* ---------------- expert / simple toggle ---------------- */
  function applyMode(){
    var on=isSimple();
    document.body.classList.toggle('simple-mode',on);
    if(on){
      if(!/^(today|book|board)$/.test(dispatchMode()))document.body.dataset.simpleMode='today';
      syncHighlight();refreshNeedsYou();renderChecklist();
    }else{
      delete document.body.dataset.simpleMode;
    }
    var ret=$('sbReturn');if(ret)ret.hidden=on;
    var cb=$('s_expert');if(cb)cb.checked=!on;
  }
  function setExpert(b){
    b=!!b;var s=S();
    s.expertMode=b;s.simpleMode=!b;doSave();
    applyMode();
    if(b){say('Expert mode — all 17 tabs are back. Settings → untick Expert mode to return.');}
    else{say('Simple mode.');if(currentView()==='dispatch')syncHighlight();}
  }

  /* ---------------- Needs-You strip ---------------- */
  function buildDispatchBits(){
    var vd=$('view-dispatch');if(!vd)return;
    if(!$('needsYou')){
      var ny=document.createElement('div');ny.id='needsYou';ny.className='ny-clear';
      ny.innerHTML='<div class="ny-head"><span class="ny-count">0</span> Nothing needs you right now</div>';
      ny.addEventListener('click',onNeedsClick);
      vd.insertBefore(ny,vd.firstChild);
    }
    if(!$('firstRun')){
      var fr=document.createElement('div');fr.id='firstRun';fr.className='panel';fr.hidden=true;
      fr.addEventListener('click',onChecklistClick);
      var anchor=$('needsYou');vd.insertBefore(fr,anchor?anchor.nextSibling:vd.firstChild);
    }
    if(!$('simpleBoardTools')){
      var bt=document.createElement('div');bt.id='simpleBoardTools';
      bt.innerHTML='<button type="button" class="btn btn-go" data-go="autoassign" title="Run the Optimizer\'s Apply all">★ Auto-assign everything</button>'+
        '<span style="flex:1"></span>'+
        '<button type="button" class="btn btn-navy" data-go="trips">All trips</button>'+
        '<button type="button" class="btn btn-navy" data-go="history">Call history</button>'+
        '<button type="button" class="btn btn-navy" data-go="map">Trip map</button>'+
        '<button type="button" class="btn btn-ghost" data-go="popout" title="Open the board on another monitor">Open on another screen</button>';
      bt.addEventListener('click',function(e){
        var b=e.target.closest('[data-go]');if(!b)return;
        var go=b.dataset.go;
        if(go==='autoassign'){if(g('optApplyAll'))window.optApplyAll();else say('Optimizer is not available.',true);return;}
        if(go==='popout'){if(g('openScreen'))window.openScreen('board');return;}
        enter('board',go);
      });
      var ba=$('boardArea');if(ba&&ba.parentNode===vd)vd.insertBefore(bt,ba);else vd.appendChild(bt);
    }
  }
  function needsYouItems(){
    var now=new Date(),nowMs=now.getTime();
    var lead=(Number(S().leadMins)||60)*60000;
    var weekAgo=nowMs-7*86400000,items=[];
    (STATE.trips||[]).forEach(function(t){
      if(!t||t._hist)return;
      var no='#'+(t.dispatchNo||'?'),who=t.passenger||t.phone||'passenger';
      var dt=pickup(t),dtm=dt?dt.getTime():null;
      if(t.status==='Booked'&&!t.driverId&&dtm!==null){
        var diff=dtm-nowMs;
        if(diff<=0&&diff>-12*3600000){
          var ago=Math.round(-diff/60000);
          items.push({k:'due',pri:0,at:dtm,id:t.id,txt:'<b>'+escH(no)+' '+escH(who)+'</b> — pickup '+escH(h12(t.time))+(ago>=1?' was '+ago+' min ago':' is now')+' and nobody is assigned.',acts:[['best','★ Best','btn-go'],['open','Open','btn-ghost']]});
        }else if(diff>0&&diff<=lead){
          items.push({k:'soon',pri:3,at:dtm,id:t.id,txt:'<b>'+escH(no)+' '+escH(who)+'</b> — pickup at '+escH(h12(t.time))+' (in '+Math.round(diff/60000)+' min) has no driver yet.',acts:[['best','★ Best','btn-go'],['open','Open','btn-ghost']]});
        }
      }
      if(t.status==='Dispatched'){
        var st=dispatchedAt(t),stm=st?st.getTime():null;
        if(stm!==null&&nowMs-stm>90*60000&&nowMs-stm<48*3600000){
          var mins=Math.round((nowMs-stm)/60000),lbl=mins>=120?Math.floor(mins/60)+' h '+(mins%60)+' min':mins+' min';
          items.push({k:'long',pri:1,at:stm,id:t.id,txt:'<b>'+escH(no)+' '+escH(who)+'</b> — driver sent '+(t.dispTime?'at '+escH(h12(t.dispTime)):'')+' ('+lbl+' ago) and the trip is still not marked done.',acts:[['done','Mark done','btn-go'],['open','Open','btn-ghost']]});
        }
      }
      if(t.status==='Completed'&&t.payType==='Credit Card'&&!(t.payment&&t.payment.status==='paid')){
        var ref=dtm;
        if(t.dropDate){var p=t.dropDate.split('-').map(Number);var dd=new Date(p[0],p[1]-1,p[2]);if(!isNaN(dd))ref=dd.getTime();}
        if(ref!==null&&ref>=weekAgo){
          items.push({k:'unpaid',pri:2,at:ref,id:t.id,txt:'<b>'+escH(no)+' '+escH(who)+'</b> — card trip ('+escH(fmtMoney((Number(t.fare)||0)+(Number(t.tolls)||0)))+') is not marked paid.',acts:[['paid','Mark paid','btn-go'],['open','Open','btn-ghost']]});
        }
      }
    });
    items.sort(function(a,b){return a.pri-b.pri||a.at-b.at;});
    return items;
  }
  function refreshNeedsYou(){
    var host=$('needsYou');if(!host)return [];
    if(!isSimple()){host.classList.add('ny-clear');return [];}
    var items=[];try{items=needsYouItems();}catch(e){console.warn('simple.js needs-you',e);items=[];}
    var MAX=8,shown=items.slice(0,MAX);
    host.classList.toggle('ny-clear',!items.length);
    var h='<div class="ny-head"><span class="ny-count">'+items.length+'</span> '+(items.length?'Needs you':'Nothing needs you right now')+'</div>';
    shown.forEach(function(it){
      h+='<div class="ny-item" data-id="'+escH(it.id)+'" data-kind="'+it.k+'"><span class="ny-dot '+it.k+'"></span><span class="ny-txt">'+it.txt+'</span><span class="ny-acts">'+
        it.acts.map(function(a){return '<button type="button" class="btn btn-sm '+a[2]+'" data-act="'+a[0]+'" data-id="'+escH(it.id)+'">'+a[1]+'</button>';}).join('')+'</span></div>';
    });
    if(items.length>MAX)h+='<div class="ny-more">+'+(items.length-MAX)+' more on the board below.</div>';
    host.innerHTML=h;
    return items;
  }
  function onNeedsClick(e){
    var b=e.target.closest('[data-act]');if(!b)return;
    var id=b.dataset.id,act=b.dataset.act,t=trip(id);if(!t)return;
    if(act==='best'){if(g('bestAssign'))window.bestAssign(id);}
    else if(act==='open'){if(g('editTrip'))window.editTrip(id);}
    else if(act==='done'){if(g('cycleStatus'))window.cycleStatus(id);}
    else if(act==='paid'){
      undoable('#'+t.dispatchNo+' marked paid',function(){
        t.payment={status:'paid',method:'card',at:new Date().toISOString()};doSave();
      },[id]);
      say('#'+t.dispatchNo+' marked paid.');
    }
    refreshNeedsYou();
  }

  /* ---------------- first-run checklist ---------------- */
  function checklistSteps(){
    var s=S();
    return [
      {k:'driver',label:'Add a driver',done:(STATE.drivers||[]).length>0,btn:'Add a driver',go:'drivers'},
      {k:'phone',label:"Connect a driver's phone",done:(STATE.drivers||[]).some(function(d){return d&&d.curLoc&&d.curLoc.source==='gps';}),btn:'Connect a phone',go:'drivers'},
      {k:'ride',label:'Book a test ride',done:(STATE.trips||[]).length>0,btn:'Book a ride',go:'book'},
      {k:'text',label:'Text yourself',done:!!s._textedSelf,btn:'I did this',flag:'_textedSelf'},
      {k:'pay',label:'Take a $1 test payment',done:!!s._testPaid,btn:'I did this',flag:'_testPaid'}
    ];
  }
  function renderChecklist(){
    var host=$('firstRun');if(!host)return;
    if(!isSimple()||S()._checklistDone){host.hidden=true;return;}
    var steps=checklistSteps(),doneN=steps.filter(function(x){return x.done;}).length;
    if(doneN===steps.length){host.hidden=true;return;}
    var h='<div class="panel-head">Getting started — '+doneN+' of '+steps.length+' done<button type="button" class="fr-x" data-fr="dismiss" title="Hide this checklist">×</button></div><div class="fr-list">';
    steps.forEach(function(st,i){
      h+='<div class="fr-step'+(st.done?' done':'')+'" data-step="'+st.k+'"><span class="fr-check">'+(st.done?'✓':'')+'</span><span class="fr-body"><span class="fr-num">Step '+(i+1)+'</span><div class="fr-lbl">'+escH(st.label)+'</div></span>'+
        (st.done?'':'<button type="button" class="btn btn-navy btn-sm" data-fr="'+(st.go?'go:'+st.go:'flag:'+st.flag)+'">'+escH(st.btn)+'</button>')+'</div>';
    });
    h+='</div><div class="fr-foot">Do these once and this card goes away by itself. Settings → Print cheat sheet for the one-page daily flow.</div>';
    host.innerHTML=h;host.hidden=false;
  }
  function onChecklistClick(e){
    var b=e.target.closest('[data-fr]');if(!b)return;
    var v=b.dataset.fr;
    if(v==='dismiss'){S()._checklistDone=true;doSave();renderChecklist();say('Checklist hidden. It stays in Settings → Simple mode.');return;}
    if(v.indexOf('go:')===0){enter(v.slice(3));return;}
    if(v.indexOf('flag:')===0){S()[v.slice(5)]=true;doSave();renderChecklist();}
  }

  /* ---------------- undo ---------------- */
  var undo={snaps:null,timer:null,label:''};
  function buildUndoToast(){
    if($('undoToast'))return;
    var el=document.createElement('div');el.id='undoToast';el.setAttribute('role','status');el.setAttribute('aria-live','polite');
    el.innerHTML='<span class="ut-msg" id="undoMsg"></span><button type="button" class="ut-btn" id="undoBtn">Undo</button><button type="button" class="ut-x" id="undoClose" title="Dismiss">×</button><span class="ut-bar"></span>';
    document.body.appendChild(el);
    $('undoBtn').addEventListener('click',doUndo);
    $('undoClose').addEventListener('click',hideUndo);
  }
  function liveIds(){return (STATE.trips||[]).filter(function(t){return t&&t.status!=='Completed'&&t.status!=='Canceled'&&t.status!=='No-Show'&&t.status!=='Disregard';}).map(function(t){return t.id;});}
  function snapshot(ids){
    var out=[];(ids||[]).forEach(function(id){var t=trip(id);if(t){try{out.push(JSON.parse(JSON.stringify(t)));}catch(e){}}});return out;
  }
  function changed(snaps,ids){
    var after=snapshot(ids);
    if(after.length!==snaps.length)return true;
    try{return JSON.stringify(after)!==JSON.stringify(snaps);}catch(e){return true;}
  }
  function showUndo(label,snaps){
    if(!snaps||!snaps.length)return;
    var el=$('undoToast');if(!el)return;
    clearTimeout(undo.timer);
    undo.snaps=snaps;undo.label=label||'Change made';
    var msg=$('undoMsg');if(msg)msg.textContent=undo.label;
    el.classList.remove('show');
    void el.offsetWidth; /* restart the countdown animation */
    el.classList.add('show');
    undo.timer=setTimeout(hideUndo,10000);
  }
  function hideUndo(){clearTimeout(undo.timer);undo.timer=null;undo.snaps=null;var el=$('undoToast');if(el)el.classList.remove('show');}
  function rerenderAll(){
    try{if(g('refreshBoard'))window.refreshBoard();}catch(e){}
    var v=currentView();
    try{if(v==='trips'&&g('renderTrips'))window.renderTrips();}catch(e){}
    try{if(v==='optimizer'&&g('renderOptimizer'))window.renderOptimizer();}catch(e){}
    try{if(v==='driveriq'&&g('renderDriverIQ'))window.renderDriverIQ();}catch(e){}
    try{if(g('renderSmartTips'))window.renderSmartTips();}catch(e){}
    try{var cw=$('classicWrap');if(cw&&cw.style.display!=='none'&&g('renderClassic'))window.renderClassic();}catch(e){}
    try{refreshNeedsYou();}catch(e){}
  }
  function doUndo(){
    var snaps=undo.snaps;if(!snaps||!snaps.length){hideUndo();return;}
    var n=0;
    snaps.forEach(function(s){
      var i=(STATE.trips||[]).findIndex(function(x){return x&&x.id===s.id;});
      if(i>=0)STATE.trips[i]=s;else STATE.trips.push(s);n++;
    });
    doSave();hideUndo();rerenderAll();
    say('Undone: '+undo.label+(n>1?' ('+n+' trips)':''));
    undo.label='';
  }
  /* undoable(label, fn, ids?) — snapshot the trips, run fn, offer Undo if anything changed */
  function undoable(label,fn,ids){
    var list=ids&&ids.length?ids:liveIds();
    var snaps=snapshot(list);
    var r;
    try{r=typeof fn==='function'?fn():undefined;}finally{
      if(changed(snaps,list))showUndo(label,snaps);
    }
    return r;
  }
  function wrapUndo(name,labelFn,idsFn,opts){
    var orig=g(name);if(!orig)return;
    if(orig._simpleWrapped)return;
    var w=function(){
      var args=Array.prototype.slice.call(arguments),self=this;
      var ids=[];try{ids=idsFn.apply(null,args)||[];}catch(e){ids=[];}
      var snaps=snapshot(ids),r;
      if(opts&&opts.noConfirm&&isSimple()){
        var c=window.confirm;window.confirm=function(){return true;};
        try{r=orig.apply(self,args);}finally{window.confirm=c;}
      }else r=orig.apply(self,args);
      try{if(changed(snaps,ids))showUndo(labelFn.apply(null,args),snaps);}catch(e){}
      try{refreshNeedsYou();}catch(e){}
      return r;
    };
    w._simpleWrapped=true;w._simpleOrig=orig;
    window[name]=w;
  }
  function noOf(id){var t=trip(id);return t?'#'+t.dispatchNo:'trip';}
  function drvName(id){var d=(STATE.drivers||[]).find(function(x){return x.id===id;});return d?d.name:'driver';}
  function one(id){return [id];}
  function patchActions(){
    wrapUndo('assignDriver',function(id,val){return val?drvName(val)+' assigned to '+noOf(id):'Driver cleared on '+noOf(id);},one);
    wrapUndo('bestAssign',function(id){return 'Best driver assigned to '+noOf(id);},one);
    wrapUndo('cancelTrip',function(id){return noOf(id)+' canceled';},one,{noConfirm:true});
    wrapUndo('noShowTrip',function(id){return noOf(id)+' marked No-Show';},one,{noConfirm:true});
    wrapUndo('cycleStatus',function(id){var t=trip(id);return noOf(id)+(t?' → '+t.status:' status changed');},one);
    wrapUndo('optAssignOne',function(id,d){return drvName(d)+' assigned to '+noOf(id);},one);
    wrapUndo('diqAssign',function(id,d){return drvName(d)+' assigned to '+noOf(id);},one);
    wrapUndo('optApplyAll',function(){return 'Auto-assigned every open trip';},function(){return liveIds();});
    /* refreshBoard → also refresh the Needs-You strip and checklist */
    var rb=g('refreshBoard');
    if(rb&&!rb._simpleWrapped){
      var rbw=function(){var r=rb.apply(this,arguments);try{refreshNeedsYou();renderChecklist();}catch(e){}return r;};
      rbw._simpleWrapped=true;rbw._simpleOrig=rb;window.refreshBoard=rbw;
    }
    /* goTab → keep section highlight and body.dataset.simpleMode in step */
    var gt=g('goTab');
    if(gt&&!gt._simpleWrapped){
      var gtw=function(v){
        var r=gt.apply(this,arguments);
        try{
          if(isSimple()){
            if(v==='dispatch'&&!/^(today|book|board)$/.test(dispatchMode()))document.body.dataset.simpleMode='today';
            syncHighlight();
          }
        }catch(e){}
        return r;
      };
      gtw._simpleWrapped=true;gtw._simpleOrig=gt;window.goTab=gtw;
    }
    /* editTrip / newTrip need the form visible: Board mode shows no form */
    ['editTrip','newTrip'].forEach(function(name){
      var f=g(name);if(!f||f._simpleWrapped)return;
      var fw=function(){
        var r=f.apply(this,arguments);
        try{if(isSimple()&&dispatchMode()==='board'){document.body.dataset.simpleMode=(name==='newTrip')?'book':'today';syncHighlight();}}catch(e){}
        return r;
      };
      fw._simpleWrapped=true;fw._simpleOrig=f;window[name]=fw;
    });
  }

  /* ---------------- Settings panel ---------------- */
  function buildSettingsPanel(){
    var vs=$('view-settings');if(!vs||$('simplePanel'))return;
    var p=document.createElement('div');p.className='panel';p.id='simplePanel';
    p.innerHTML='<div class="panel-head">Simple mode</div><div class="panel-body">'+
      '<div class="sp-row"><label><input type="checkbox" id="s_expert"> Expert mode — show all 17 tabs</label>'+
      '<span class="hint" style="margin:0;">Simple mode shows six big buttons: Today · Book · Board · Drivers · Money · Settings. Every old tab is still one click deeper.</span></div>'+
      '<div class="sp-row"><label for="s_pin">Admin PIN (4 digits, optional)</label><input type="text" id="s_pin" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="••••" autocomplete="off">'+
      '<button type="button" class="btn btn-navy btn-sm" id="s_pinSave">Save PIN</button><button type="button" class="btn btn-ghost btn-sm" id="s_pinClear">Remove PIN</button>'+
      '<span class="hint" style="margin:0;">When set, opening Settings or Expert mode asks for the PIN once per session.</span></div>'+
      '<div class="sp-row"><button type="button" class="btn btn-go" id="s_cheat">Print cheat sheet</button>'+
      '<button type="button" class="btn btn-ghost" id="s_checklist">Show getting-started checklist again</button></div>'+
      '</div>';
    vs.appendChild(p);
    var cb=$('s_expert');cb.checked=!isSimple();
    cb.addEventListener('change',function(){setExpert(cb.checked);});
    var pin=$('s_pin');pin.value=/^\d{4}$/.test(String(S().adminPin||''))?String(S().adminPin):'';
    $('s_pinSave').addEventListener('click',function(){
      var v=String(pin.value||'').trim();
      if(!/^\d{4}$/.test(v)){say('The PIN must be exactly 4 digits.',true);return;}
      S().adminPin=v;pinUnlocked=true;doSave();say('Admin PIN saved.');
    });
    $('s_pinClear').addEventListener('click',function(){delete S().adminPin;pin.value='';pinUnlocked=false;doSave();say('Admin PIN removed.');});
    $('s_cheat').addEventListener('click',printCheatSheet);
    $('s_checklist').addEventListener('click',function(){S()._checklistDone=false;doSave();renderChecklist();enter('today');});
  }

  /* ---------------- cheat sheet ---------------- */
  /* Owner decision 8 (default): the passenger consent sentence every dispatcher says when taking a phone booking.
     Same string as Messages.consentSentence (messages.js); the literal here is the fallback if that file is absent. */
  var CONSENT_SENTENCE='By booking you agree to receive ride updates by text; reply STOP to opt out.';
  function consentSentence(){try{if(window.Messages&&typeof window.Messages.consentSentence==='string'&&window.Messages.consentSentence)return window.Messages.consentSentence;}catch(e){}return CONSENT_SENTENCE;}
  function cheatSheetHTML(){
    var s=S(),name=s.name||'Skyway Car Service',phone=s.phone||'';
    var lead=Number(s.leadMins)||60;
    return '<!doctype html><html><head><meta charset="utf-8"><title>'+escH(name)+' — Dispatcher cheat sheet</title>'+
      '<style>body{font-family:Calibri,"Segoe UI",Arial,sans-serif;color:#1f1f1f;margin:28px 36px;font-size:13.5px;line-height:1.45;}'+
      'h1{font-size:22px;margin:0 0 2px;}h2{font-size:14px;text-transform:uppercase;letter-spacing:.8px;color:#1c5b9c;border-bottom:2px solid #1c5b9c;margin:18px 0 8px;padding-bottom:2px;}'+
      '.sub{color:#666;margin-bottom:10px;}ol,ul{margin:0 0 0 20px;padding:0;}li{margin:3px 0;}'+
      '.cols{display:grid;grid-template-columns:1fr 1fr;gap:0 28px;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top;}th{background:#f2f2f2;}'+
      'kbd{font-family:Consolas,monospace;background:#eee;border:1px solid #bbb;border-radius:3px;padding:0 5px;font-size:12px;}'+
      '.say{font-weight:700;background:#fff6c4;padding:1px 4px;border-radius:3px;}.note{color:#666;font-size:12px;}'+
      '.btn{display:inline-block;background:#1c5b9c;color:#fff;border:none;padding:8px 16px;font-size:14px;cursor:pointer;border-radius:6px;margin-bottom:14px;}'+
      '@media print{.btn{display:none;}body{margin:12mm;}}</style></head><body>'+
      '<button class="btn" onclick="window.print()">Print this page</button>'+
      '<h1>'+escH(name)+' — Dispatcher cheat sheet</h1><div class="sub">'+(phone?'Office '+escH(phone)+' · ':'')+'Keep this next to the keyboard. The whole job is <b>Book</b> and <b>Assign</b>.</div>'+
      '<div class="cols"><div>'+
      '<h2>The six buttons</h2><table><tr><th>Button</th><th>What it is for</th></tr>'+
      '<tr><td><b>TODAY</b></td><td>Home screen: Needs-You list, caller ID lines, quick booking form, live board and map.</td></tr>'+
      '<tr><td><b>BOOK</b></td><td>The full booking form by itself with the route preview.</td></tr>'+
      '<tr><td><b>BOARD</b></td><td>Every live trip, full width. Also Trips, Call history and Trip map.</td></tr>'+
      '<tr><td><b>DRIVERS</b></td><td>Fleet (drivers &amp; cars), Driver IQ, Optimizer, Zone map.</td></tr>'+
      '<tr><td><b>MONEY</b></td><td>Earnings, Accounts, Invoices, Business P&amp;L, TLC export.</td></tr>'+
      '<tr><td><b>SETTINGS</b></td><td>Company details, Rates &amp; zones, Address book, Fare estimate, Expert mode.</td></tr></table>'+
      '<h2>A call comes in</h2><ol>'+
      '<li>Press <kbd>F1</kbd>–<kbd>F6</kbd> for the ringing line (or <kbd>F2</kbd> New Trip). The caller’s number and last trips fill in.</li>'+
      '<li>Type the <b>pick-up</b> and <b>drop-off</b> — choose from the dropdown so the map and price fill in.</li>'+
      '<li>Set <b>when</b> (ASAP or a date/time), passengers and car type.</li>'+
      '<li><b>Say to the caller:</b> <span class="say">“'+escH(consentSentence())+'”</span> <span class="note">(required for text updates — say it every time you book by phone)</span></li>'+
      '<li>Press <b>Save Trip</b>. The ride is on the board; it moves to <i>Active / Due Now</i> '+lead+' min before pickup.</li></ol>'+
      '<h2>Sending a driver</h2><ol>'+
      '<li>On the board row press <b>★ Best</b> — the best free driver is chosen (or pick one from the Driver box).</li>'+
      '<li>Press <b>Dispatch</b> when the driver leaves, <b>Complete</b> when the passenger is dropped off.</li>'+
      '<li>Made a mistake? Press <b>Undo</b> in the black bar within 10 seconds.</li></ol>'+
      '</div><div>'+
      '<h2>Needs You (top of Today)</h2><ul>'+
      '<li><b>No driver and pickup is now</b> — press ★ Best.</li>'+
      '<li><b>Driver out more than 90 min</b> — call the driver, then Mark done.</li>'+
      '<li><b>Card trip not marked paid</b> — charge on Square, then Mark paid.</li>'+
      '<li><b>Reservation coming up with no driver</b> — assign early.</li></ul>'+
      '<h2>Keyboard</h2><table><tr><th>Key</th><th>Does</th></tr>'+
      '<tr><td><kbd>F1</kbd>–<kbd>F6</kbd></td><td>Open a new job from caller-ID line 1–6 (F1 also opens Help when no line is ringing)</td></tr>'+
      '<tr><td><kbd>F2</kbd></td><td>New trip</td></tr><tr><td><kbd>F3</kbd></td><td>Find a trip</td></tr>'+
      '<tr><td><kbd>F4</kbd></td><td>Go to the board</td></tr><tr><td><kbd>F5</kbd></td><td>Refresh the board</td></tr>'+
      '<tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>Search job #, phone, name, account, driver, address</td></tr>'+
      '<tr><td><kbd>Esc</kbd></td><td>Close a pop-up or search</td></tr></table>'+
      '<h2>Row colours</h2><ul><li><b>Grey</b> booked · <b>Yellow</b> pickup soon · <b>Red</b> due now / late · <b>Blue</b> driver dispatched.</li></ul>'+
      '<h2>End of day</h2><ol><li>BOARD → make sure every trip is Complete, Canceled or No-Show.</li><li>MONEY → Earnings for driver settlement; Invoices for account customers.</li><li>SETTINGS → Export Backup (.json) once a day.</li></ol>'+
      '<h2>Stuck?</h2><ul><li>Press the round <b>?</b> button at the top right.</li><li>Expert mode (Settings) brings back all 17 tabs for the owner.</li></ul>'+
      '</div></div></body></html>';
  }
  function printCheatSheet(){
    var w=null;
    try{w=window.open('','skyway_cheatsheet','width=900,height=1000,menubar=no,toolbar=no,location=no,resizable=yes,scrollbars=yes');}catch(e){w=null;}
    if(!w){say('Allow pop-ups for this page, then try again.',true);return false;}
    try{w.document.open();w.document.write(cheatSheetHTML());w.document.close();w.focus();}catch(e){say('Could not open the cheat sheet.',true);return false;}
    return true;
  }

  /* ---------------- init ---------------- */
  function init(){
    var s=S();
    if(s.simpleMode===undefined){s.simpleMode=true;doSave();}
    try{buildBar();}catch(e){console.warn('simple.js bar',e);}
    try{buildDispatchBits();}catch(e){console.warn('simple.js dispatch bits',e);}
    try{buildSettingsPanel();}catch(e){console.warn('simple.js settings',e);}
    try{buildUndoToast();}catch(e){console.warn('simple.js undo',e);}
    try{patchActions();}catch(e){console.warn('simple.js patch',e);}
    try{applyMode();}catch(e){console.warn('simple.js mode',e);}
    /* keyboard: Alt+1..6 jump to a section (does not touch the F-keys) */
    document.addEventListener('keydown',function(e){
      if(!isSimple()||!e.altKey||e.ctrlKey||e.metaKey)return;
      var n=parseInt(e.key,10);if(!(n>=1&&n<=6))return;
      var tag=(e.target&&e.target.tagName||'').toLowerCase();if(tag==='input'||tag==='textarea'||tag==='select')return;
      e.preventDefault();enter(SECTIONS[n-1].id);
    });
  }

  window.Simple={
    _loaded:true,
    enter:enter,
    refreshNeedsYou:refreshNeedsYou,
    undoable:undoable,
    setExpert:setExpert,
    isSimple:isSimple,
    renderChecklist:renderChecklist,
    printCheatSheet:printCheatSheet,
    undo:doUndo,
    sections:SECTIONS.map(function(s){return s.id;})
  };

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
