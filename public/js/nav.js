async function initNav() {
  const res = await fetch('/api/me');
  if (!res.ok) { window.location='/'; return null; }
  const user = await res.json();
  const el=document.getElementById('navCredits'); if(el) el.textContent='$'+(user.credits/100).toFixed(2);
  const un=document.getElementById('navUser'); if(un) un.textContent=user.username;
  if(user.role==='admin'||user.role==='reseller'){
    const btn=document.getElementById('navPanel');
    if(btn){btn.style.display='inline-block';btn.href=user.role==='admin'?'/admin':'/reseller';btn.textContent=user.role==='admin'?'⬡ Admin':'◈ Reseller';}
  }
  return user;
}
async function navLogout(){await fetch('/api/auth/logout',{method:'POST'});window.location='/';}
