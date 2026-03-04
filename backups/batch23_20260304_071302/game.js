const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─── XP SYSTEM ──────────────────────────────────────────────────────────────
let awardXP, XP_REWARDS;
try {
  const levels = require('./levels');
  awardXP = levels.awardXP;
  XP_REWARDS = levels.XP_REWARDS;
} catch(e) {
  console.warn('Levels module not found — XP disabled');
  awardXP = () => null;
  XP_REWARDS = { spin:0, win:0, big_win:0, mega_win:0, jackpot:0, crash_play:0, crash_win:0, table_play:0, table_win:0, daily_bonus:0 };
}

function calcXP(bet, payout, type) {
  var xp = XP_REWARDS[type] || XP_REWARDS.spin || 5;
  if (payout > 0) xp += XP_REWARDS.win || 10;
  if (payout >= bet * 5) xp += XP_REWARDS.big_win || 25;
  if (payout >= bet * 20) xp += XP_REWARDS.mega_win || 50;
  return xp;
}

// ─── ACHIEVEMENT & TOURNAMENT TRACKING ────────────────────────────────────────
var achievementsModule = null;
try { achievementsModule = require('./achievements'); } catch(e) { console.log('Achievements module not loaded:', e.message); }
var tournamentsModule = null;
try { tournamentsModule = require('./tournaments'); } catch(e) { console.log('Tournaments module not loaded:', e.message); }

var monetizationModule = null;
try { monetizationModule = require('./monetization'); } catch(e) { console.log('Monetization module not loaded:', e.message); }

function trackSpin(userId, bet, payout, game) {
  try {
    var newAchievements = [];
    if (achievementsModule && achievementsModule.checkAfterSpin) {
      newAchievements = achievementsModule.checkAfterSpin(userId, bet, payout, game);
    }
    if (tournamentsModule && tournamentsModule.recordTournamentSpin) {
      tournamentsModule.recordTournamentSpin(userId, game, bet, payout);
    }
    // Check for suspicious activity every 25th spin
    if (monetizationModule && monetizationModule.checkSuspicious) {
      var cnt = db.prepare('SELECT COUNT(*) as c FROM spins WHERE user_id=?').get(userId).c;
      if (cnt % 25 === 0) monetizationModule.checkSuspicious(userId);
    }
    return newAchievements;
  } catch(e) { console.error('Track spin error:', e.message); return []; }
}

function getSetting(key) { return db.getSettingNum(key); }
function getSettingStr(key) { return db.getSetting(key); }

function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

// ─── RTP HELPER ───────────────────────────────────────────────────────────────
// For card/table games where math is fixed: occasionally suppress the smallest
// winning hand to enforce house edge beyond the natural game odds.
function shouldForceHouseLoss(rtpPct) {
  const houseEdge = 1 - (rtpPct / 100);
  return Math.random() < houseEdge;
}

// ─── JACKPOT HELPERS (DB-persisted) ──────────────────────────────────────────
function getJackpots() {
  return {
    mini:  getSetting('jackpot_mini')  || getSetting('jackpot_mini_seed')  || 50000,
    major: getSetting('jackpot_major') || getSetting('jackpot_major_seed') || 500000,
    grand: getSetting('jackpot_grand') || getSetting('jackpot_grand_seed') || 2000000,
  };
}
function setJackpot(type, value) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('jackpot_'+type, String(value));
}
function getJackpotSeeds() {
  return {
    mini:  getSetting('jackpot_mini_seed')  || 50000,
    major: getSetting('jackpot_major_seed') || 500000,
    grand: getSetting('jackpot_grand_seed') || 2000000,
  };
}

// ─── CLASSIC SLOTS (3-reel) ──────────────────────────────────────────────────
const SYMBOLS_3 = ['🍒','🍋','🍊','⭐','💎','7️⃣'];
const PAYOUTS_3 = {'7️⃣':50,'💎':25,'⭐':15,'🍊':8,'🍒':6,'🍋':5};

function getWeights3(rtp) {
  const edge = 100 - rtp;
  return [
    Math.round(30 + edge * 0.30),               // 🍒 common
    Math.round(25 + edge * 0.20),               // 🍋
    Math.round(18 + edge * 0.10),               // 🍊
    Math.round(12 - edge * 0.10),               // ⭐
    Math.max(1, Math.round(8  - edge * 0.30)),  // 💎
    Math.max(1, Math.round(4  - edge * 0.20)),  // 7️⃣
  ];
}
function calcPayout3(reels, bet) {
  if (reels[0]===reels[1]&&reels[1]===reels[2]) return bet*(PAYOUTS_3[reels[0]]||10);
  if (reels[0]===reels[1]||reels[1]===reels[2]||reels[0]===reels[2]) return Math.round(bet*1.5);
  return 0;
}

router.post('/spin', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const minBet = getSetting('min_bet'), maxBet = getSetting('max_bet');
  const bet = Math.round(parseFloat(req.body.bet||minBet));
  if (bet<minBet||bet>maxBet) return res.status(400).json({error:`Bet $${(minBet/100).toFixed(2)}–$${(maxBet/100).toFixed(2)}`});
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user||user.credits<bet) return res.status(400).json({error:'Insufficient credits'});
  const weights = getWeights3(getSetting('rtp_slots'));
  const reels = [weightedPick(SYMBOLS_3,weights),weightedPick(SYMBOLS_3,weights),weightedPick(SYMBOLS_3,weights)];
  const payout = calcPayout3(reels,bet);
  const newCredits = user.credits-bet+payout;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(userId,'slots',bet,reels.join(','),payout);
  var xp = awardXP(userId, calcXP(bet, payout, 'spin'), 'slots');
  var ach = trackSpin(userId, bet, payout, 'slots');
  res.json({reels,win:payout,credits:newCredits,xp,achievements:ach});
});

// ─── PRO SLOTS (5-reel + jackpots) ───────────────────────────────────────────
const SYMBOLS_5 = ['🍒','🍋','🍊','🔔','⭐','💎','7️⃣','🃏'];
const PAYOUTS_5 = {
  5:{'7️⃣':500,'💎':200,'⭐':100,'🔔':50,'🍊':30,'🍒':20,'🍋':15,'🃏':10},
  4:{'7️⃣':100,'💎':50,'⭐':25,'🔔':15,'🍊':10,'🍒':8,'🍋':6,'🃏':5},
  3:{'7️⃣':30,'💎':15,'⭐':10,'🔔':6,'🍊':4,'🍒':3,'🍋':2,'🃏':2}
};
function getWeights5(rtp) {
  const edge = 100 - rtp;
  return [
    Math.round(22 + edge * 0.20),               // 🍒
    Math.round(18 + edge * 0.15),               // 🍋
    Math.round(15 + edge * 0.10),               // 🍊
    Math.round(13 + edge * 0.05),               // 🔔
    Math.max(1, Math.round(12 - edge * 0.15)),  // ⭐
    Math.max(1, Math.round(8  - edge * 0.20)),  // 💎
    Math.max(1, Math.round(7  - edge * 0.15)),  // 7️⃣
    Math.max(1, Math.round(5  - edge * 0.05)),  // 🃏 wild
  ];
}
function calcPayout5(reels,bet){
  const first=reels.find(s=>s!=='🃏')||'🃏';
  let streak=0;
  for(const s of reels){if(s===first||s==='🃏')streak++;else break;}
  if(streak>=3)return Math.round(bet*(PAYOUTS_5[streak]?.[first]||2));
  const wilds=reels.filter(s=>s==='🃏').length;
  if(wilds>=3)return Math.round(bet*wilds*5);
  return 0;
}
function checkJackpot5(reels,bet){
  const j=getJackpots(); const s=getJackpotSeeds();
  if(reels.every(r=>r==='7️⃣'))  { setJackpot('grand',s.grand); return {type:'grand',win:j.grand}; }
  if(reels.every(r=>r==='💎'))  { setJackpot('major',s.major); return {type:'major',win:j.major}; }
  if(reels.every(r=>r==='⭐'))  { setJackpot('mini', s.mini);  return {type:'mini', win:j.mini};  }
  const j2=getJackpots();
  setJackpot('mini',  j2.mini  + Math.round(bet*0.005));
  setJackpot('major', j2.major + Math.round(bet*0.01));
  setJackpot('grand', j2.grand + Math.round(bet*0.02));
  return null;
}

router.post('/spin-pro', requireAuth, (req, res) => {
  const userId=req.session.userId;
  const minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const bet=Math.round(parseFloat(req.body.bet||minBet));
  if(bet<minBet||bet>maxBet) return res.status(400).json({error:`Bet $${(minBet/100).toFixed(2)}–$${(maxBet/100).toFixed(2)}`});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user||user.credits<bet) return res.status(400).json({error:'Insufficient credits'});
  const weights=getWeights5(getSetting('rtp_slots_pro'));
  const reels=Array.from({length:5},()=>weightedPick(SYMBOLS_5,weights));
  const jackpotWin=checkJackpot5(reels,bet);
  const basePayout=calcPayout5(reels,bet);
  const payout=jackpotWin?jackpotWin.win:basePayout;
  const newCredits=user.credits-bet+payout;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(userId,'slots_pro',bet,reels.join(','),payout);
  var xpAmt = calcXP(bet, payout, 'spin');
  if (jackpotWin) xpAmt += XP_REWARDS.jackpot;
  var xp = awardXP(userId, xpAmt, 'slots_pro');
  var ach = trackSpin(userId, bet, payout, 'slots_pro');
  if (jackpotWin && achievementsModule) { try { achievementsModule.checkJackpot(userId, jackpotWin.type); } catch(e){} }
  const j=getJackpots();
  res.json({reels,win:payout,credits:newCredits,jackpot:jackpotWin,jackpots:{mini:j.mini,major:j.major,grand:j.grand},xp,achievements:ach});
});

router.get('/jackpots', requireAuth, (req,res) => { res.json({jackpots:getJackpots()}); });

// ─── CRASH ────────────────────────────────────────────────────────────────────
function generateCrashPoint(rtp) {
  const houseEdge=1-(rtp/100);
  const r=Math.random();
  if(r<houseEdge)return 100;
  const mult=Math.floor((1/(1-r))*100);
  const maxMult=parseInt(getSettingStr('crash_max_mult')||'100')*100;
  return Math.min(mult,maxMult);
}
router.post('/crash/bet', requireAuth, (req, res) => {
  const userId=req.session.userId;
  const minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const bet=Math.round(parseFloat(req.body.bet||minBet));
  const cashoutAt=Math.round(parseFloat(req.body.cashoutAt||200));
  if(bet<minBet||bet>maxBet) return res.status(400).json({error:`Bet $${(minBet/100).toFixed(2)}–$${(maxBet/100).toFixed(2)}`});
  if(cashoutAt<110) return res.status(400).json({error:'Cashout min 1.10x'});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user||user.credits<bet) return res.status(400).json({error:'Insufficient credits'});
  const crashPoint=generateCrashPoint(getSetting('rtp_crash'));
  const won=cashoutAt<=crashPoint;
  const payout=won?Math.round(bet*cashoutAt/100):0;
  const newCredits=user.credits-bet+payout;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(userId,'crash',bet,`crash@${(crashPoint/100).toFixed(2)}x`,payout);
  db.prepare('INSERT INTO crash_rounds(crash_point) VALUES(?)').run(crashPoint);
  var xpAmt = XP_REWARDS.crash_play;
  if (won) xpAmt += XP_REWARDS.crash_win;
  if (payout >= bet * 5) xpAmt += XP_REWARDS.big_win;
  if (payout >= bet * 20) xpAmt += XP_REWARDS.mega_win;
  var xp = awardXP(userId, xpAmt, 'crash');
  var ach = trackSpin(userId, bet, payout, 'crash');
  res.json({crashPoint:(crashPoint/100).toFixed(2),cashedOutAt:won?(cashoutAt/100).toFixed(2):null,win:payout,credits:newCredits,won,xp,achievements:ach});
});
router.get('/crash/history', requireAuth, (req, res) => {
  const history=db.prepare('SELECT crash_point,created_at FROM crash_rounds ORDER BY id DESC LIMIT 20').all();
  res.json({history:history.map(r=>({point:(r.crash_point/100).toFixed(2),at:r.created_at}))});
});

// Manual cashout — player clicked cash out during flight
router.post('/crash/manual-cashout', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const bet = Math.round(parseFloat(req.body.bet || 0));
  const cashoutMult = parseFloat(req.body.cashoutMult || 1);

  if (bet <= 0 || cashoutMult < 1.01) return res.status(400).json({ error: 'Invalid cashout' });

  // Find the most recent crash spin for this user
  const lastSpin = db.prepare(
    `SELECT id, payout, result FROM spins WHERE user_id=? AND game='crash' ORDER BY id DESC LIMIT 1`
  ).get(userId);

  if (!lastSpin) return res.status(400).json({ error: 'No active crash round' });

  // Extract the crash point from the result string
  const match = lastSpin.result.match(/crash@([\d.]+)x/);
  if (!match) return res.status(400).json({ error: 'Invalid crash round' });
  const crashPoint = parseFloat(match[1]);

  // Validate: player must have cashed out BEFORE the crash
  if (cashoutMult >= crashPoint) {
    return res.status(400).json({ error: 'Crash occurred before cashout' });
  }

  // Calculate payout
  const payout = Math.round(bet * cashoutMult);
  const prevPayout = lastSpin.payout || 0;
  const creditDiff = payout - prevPayout;

  // Update the spin record and credits
  const user = db.prepare('SELECT credits FROM users WHERE id=?').get(userId);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const newCredits = user.credits + creditDiff;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits, userId);
  db.prepare('UPDATE spins SET payout=?, result=? WHERE id=?').run(
    payout,
    `crash@${crashPoint.toFixed(2)}x:cashout@${cashoutMult.toFixed(2)}x`,
    lastSpin.id
  );

  trackSpin(userId, bet, payout, 'crash');
  res.json({ credits: newCredits, win: payout, cashedOutAt: cashoutMult.toFixed(2), xp: null });
});

// ─── BLACKJACK ────────────────────────────────────────────────────────────────
// RTP lever: at rtp_blackjack < 98, dealer hits soft 17 (tightens house edge).
// At rtp_blackjack < 97, ties (push) occasionally resolve as dealer wins.
const DECK=[];
const SUITS=['♠','♥','♦','♣'];
const RANKS=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
for(const s of SUITS) for(const r of RANKS) DECK.push({r,s});
function cardValue(rank){if(['J','Q','K'].includes(rank))return 10;if(rank==='A')return 11;return parseInt(rank);}
function handTotal(hand){let total=0,aces=0;for(const c of hand){total+=cardValue(c.r);if(c.r==='A')aces++;}while(total>21&&aces>0){total-=10;aces--;}return total;}
function dealHand(){const deck=[...DECK].sort(()=>Math.random()-0.5);return{player:[deck.pop(),deck.pop()],dealer:[deck.pop(),deck.pop()],deck};}

router.post('/blackjack/deal', requireAuth, (req, res) => {
  const userId=req.session.userId;
  const minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const bet=Math.round(parseFloat(req.body.bet||minBet));
  if(bet<minBet||bet>maxBet) return res.status(400).json({error:'Invalid bet'});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user||user.credits<bet) return res.status(400).json({error:'Insufficient credits'});
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(user.credits-bet,userId);
  const{player,dealer,deck}=dealHand();
  const playerTotal=handTotal(player);
  res.json({player,dealer:[dealer[0],{r:'?',s:'?'}],dealerHidden:dealer[1],deck:deck.slice(0,10),bet,playerTotal,blackjack:playerTotal===21,credits:user.credits-bet});
});

router.post('/blackjack/action', requireAuth, (req, res) => {
  const userId=req.session.userId;
  const{action,player,dealer,deck,bet}=req.body;
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  let pHand=[...player],dHand=[...dealer],remaining=[...deck];
  const rtp=getSetting('rtp_blackjack');
  if(action==='hit'){
    pHand.push(remaining.pop());
    const total=handTotal(pHand);
    if(total>21){db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(userId,'blackjack',bet,'bust',0);var xp=awardXP(userId,XP_REWARDS.table_play,'blackjack');trackSpin(userId,bet,0,'blackjack');return res.json({player:pHand,dealer:dHand,deck:remaining,playerTotal:total,result:'bust',win:0,credits:user.credits,xp});}
    return res.json({player:pHand,dealer:dHand,deck:remaining,playerTotal:total,result:'continue',credits:user.credits});
  }
  if(action==='stand'||action==='double'){
    if(action==='double'){if(user.credits<bet)return res.status(400).json({error:'Insufficient credits'});db.prepare('UPDATE users SET credits=? WHERE id=?').run(user.credits-bet,userId);pHand.push(remaining.pop());user.credits-=bet;}
    // Dealer rule: hit soft 17 when RTP < 98 (increases house edge ~0.2%)
    while(true){
      const dt=handTotal(dHand);
      if(dt>17)break;
      if(dt===17){
        const isSoft=dHand.some(c=>c.r==='A')&&dt===17;
        if(rtp<98&&isSoft){dHand.push(remaining.pop());continue;}
        break;
      }
      dHand.push(remaining.pop());
    }
    const pTotal=handTotal(pHand),dTotal=handTotal(dHand);
    let result,payout=0;
    const betAmt=action==='double'?bet*2:bet;
    if(pTotal>21){result='bust';}
    else if(dTotal>21||pTotal>dTotal){result='win';payout=betAmt*2;}
    else if(pTotal===dTotal){
      // At rtp < 97: ties occasionally become dealer wins (~3% of ties → house +0.15% edge)
      const tieHouseWins=rtp<97&&Math.random()<0.15;
      result=tieHouseWins?'lose':'push';
      if(!tieHouseWins)payout=betAmt;
    }
    else{result='lose';}
    const newCredits=user.credits+payout;
    db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
    db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(userId,'blackjack',betAmt,`p${pTotal}d${dTotal}`,payout);
    var bjXp = XP_REWARDS.table_play;
    if (payout > 0) bjXp += XP_REWARDS.table_win;
    var xp = awardXP(userId, bjXp, 'blackjack');
    var ach = trackSpin(userId, bet, payout, 'blackjack');
    return res.json({player:pHand,dealer:dHand,deck:remaining,playerTotal:pTotal,dealerTotal:dTotal,result,win:payout,credits:newCredits,xp,achievements:ach});
  }
});

// ─── ROULETTE ─────────────────────────────────────────────────────────────────
// RTP lever: standard Euro roulette = 97.3% (1 green pocket out of 37).
// Below 97.3%: we add probability of forcing the spin to land on 0 (green).
const ROULETTE_REDS=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
router.post('/roulette/spin', requireAuth, (req, res) => {
  const userId=req.session.userId;
  const minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const{bets}=req.body;
  if(!bets||!bets.length)return res.status(400).json({error:'No bets'});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const totalBet=bets.reduce((s,b)=>s+Math.round(parseFloat(b.amount)),0);
  if(totalBet<minBet||totalBet>maxBet*5)return res.status(400).json({error:'Invalid total bet'});
  if(user.credits<totalBet)return res.status(400).json({error:'Insufficient credits'});
  const rtp=getSetting('rtp_roulette');
  // Standard Euro house edge is 1/37 ≈ 2.7%. Extra edge forces zero more often.
  const standardEdge=1/37;
  const targetEdge=1-(rtp/100);
  const extraEdge=Math.max(0,targetEdge-standardEdge);
  const number=Math.random()<extraEdge ? 0 : Math.floor(Math.random()*37);
  const isRed=ROULETTE_REDS.includes(number);
  const isBlack=number>0&&!isRed;
  const isGreen=number===0;
  let totalPayout=0;
  for(const b of bets){
    const amt=Math.round(parseFloat(b.amount));
    let mult=0;
    if(b.type==='number'&&parseInt(b.value)===number)mult=36;
    else if(b.type==='red'&&isRed)mult=2;
    else if(b.type==='black'&&isBlack)mult=2;
    else if(b.type==='even'&&number>0&&number%2===0)mult=2;
    else if(b.type==='odd'&&number%2===1)mult=2;
    else if(b.type==='low'&&number>=1&&number<=18)mult=2;
    else if(b.type==='high'&&number>=19&&number<=36)mult=2;
    else if(b.type==='dozen'&&Math.ceil(number/12)===parseInt(b.value))mult=3;
    else if(b.type==='column'){const col=parseInt(b.value);if(number>0&&number%3===(col===3?0:col))mult=3;}
    totalPayout+=amt*mult;
  }
  const newCredits=user.credits-totalBet+totalPayout;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(userId,'roulette',totalBet,`${number}(${isGreen?'G':isRed?'R':'B'})`,totalPayout);
  var rXp = XP_REWARDS.table_play;
  if (totalPayout > 0) rXp += XP_REWARDS.table_win;
  if (totalPayout >= totalBet * 5) rXp += XP_REWARDS.big_win;
  if (totalPayout >= totalBet * 20) rXp += XP_REWARDS.mega_win;
  var xp = awardXP(userId, rXp, 'roulette');
  var ach = trackSpin(userId, totalBet, totalPayout, 'roulette');
  res.json({number,isRed,isBlack,isGreen,totalBet,win:totalPayout,credits:newCredits,xp,achievements:ach});
});

// ─── VIDEO POKER ──────────────────────────────────────────────────────────────
// RTP lever: suppress Jacks-or-Better (1×) payout at low RTP settings.
// At very low RTP, also suppress Two Pair (2×) occasionally.
function pokerHandRank(hand){
  const ranks=hand.map(c=>c.r),suits=hand.map(c=>c.s),rankCounts={};
  for(const r of ranks)rankCounts[r]=(rankCounts[r]||0)+1;
  const counts=Object.values(rankCounts).sort((a,b)=>b-a);
  const flush=suits.every(s=>s===suits[0]);
  const rankOrder=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const indices=ranks.map(r=>rankOrder.indexOf(r)).sort((a,b)=>a-b);
  const straight=indices[4]-indices[0]===4&&new Set(indices).size===5;
  if(flush&&straight&&indices[0]===8)return{name:'Royal Flush',mult:800};
  if(flush&&straight)return{name:'Straight Flush',mult:50};
  if(counts[0]===4)return{name:'Four of a Kind',mult:25};
  if(counts[0]===3&&counts[1]===2)return{name:'Full House',mult:9};
  if(flush)return{name:'Flush',mult:6};
  if(straight)return{name:'Straight',mult:4};
  if(counts[0]===3)return{name:'Three of a Kind',mult:3};
  if(counts[0]===2&&counts[1]===2)return{name:'Two Pair',mult:2};
  if(counts[0]===2){const pair=Object.keys(rankCounts).find(r=>rankCounts[r]===2);if(['J','Q','K','A'].includes(pair))return{name:'Jacks or Better',mult:1};}
  return{name:'No Win',mult:0};
}
router.post('/poker/deal', requireAuth, (req, res) => {
  const userId=req.session.userId,minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const bet=Math.round(parseFloat(req.body.bet||minBet));
  if(bet<minBet||bet>maxBet)return res.status(400).json({error:'Invalid bet'});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user||user.credits<bet)return res.status(400).json({error:'Insufficient credits'});
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(user.credits-bet,userId);
  const deck=[...DECK].sort(()=>Math.random()-0.5);
  res.json({hand:deck.splice(0,5),deck:deck.slice(0,10),bet,credits:user.credits-bet});
});
router.post('/poker/draw', requireAuth, (req, res) => {
  const userId=req.session.userId,{hand,deck,hold,bet}=req.body;
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const remaining=[...deck];
  const newHand=hand.map((c,i)=>hold.includes(i)?c:remaining.pop());
  let{name,mult}=pokerHandRank(newHand);
  const rtp=getSetting('rtp_poker');
  // Suppress small wins at low RTP
  if(mult===1&&rtp<98&&shouldForceHouseLoss(rtp)){mult=0;name='No Win';}
  if(mult===2&&name==='Two Pair'&&rtp<95&&shouldForceHouseLoss(rtp)){mult=0;name='No Win';}
  const payout=Math.round(bet*mult);
  const newCredits=user.credits+payout;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(userId,'poker',bet,name,payout);
  var pkXp = XP_REWARDS.table_play;
  if (payout > 0) pkXp += XP_REWARDS.table_win;
  if (payout >= bet * 5) pkXp += XP_REWARDS.big_win;
  if (payout >= bet * 20) pkXp += XP_REWARDS.mega_win;
  var xp = awardXP(userId, pkXp, 'poker');
  var ach = trackSpin(userId, bet, payout, 'poker');
  res.json({hand:newHand,rank:{name,mult},win:payout,credits:newCredits,xp,achievements:ach});
});

// ─── PULL TAB ─────────────────────────────────────────────────────────────────
// RTP lever: ❌ (losing symbol) weight scales directly with house edge.
const PULL_SYMBOLS=['💰','⭐','🍀','🔔','🎁','💎','7️⃣','❌'];
const PULL_PAYOUTS={'💰💰💰':100,'7️⃣7️⃣7️⃣':50,'💎💎💎':25,'🍀🍀🍀':15,'⭐⭐⭐':10,'🔔🔔🔔':8,'🎁🎁🎁':5,'💰💰':3,'⭐⭐':2,'🔔🔔':2};
function getPullWeights(rtp){
  const edge=100-rtp;
  return [
    Math.max(1,Math.round(5  - edge*0.05)),  // 💰
    Math.max(1,Math.round(8  - edge*0.03)),  // ⭐
    Math.max(1,Math.round(8  - edge*0.03)),  // 🍀
    Math.max(1,Math.round(8  - edge*0.03)),  // 🔔
    Math.max(1,Math.round(6  - edge*0.03)),  // 🎁
    Math.max(1,Math.round(4  - edge*0.05)),  // 💎
    Math.max(1,Math.round(2  - edge*0.02)),  // 7️⃣
    Math.min(95,Math.round(59 + edge*0.24)), // ❌ lose
  ];
}
router.post('/pulltab/pull', requireAuth, (req, res) => {
  const userId=req.session.userId,minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const bet=Math.round(parseFloat(req.body.bet||minBet));
  if(bet<minBet||bet>maxBet)return res.status(400).json({error:'Invalid bet'});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user||user.credits<bet)return res.status(400).json({error:'Insufficient credits'});
  const weights=getPullWeights(getSetting('rtp_pulltab'));
  const tabs=Array.from({length:3},()=>weightedPick(PULL_SYMBOLS,weights));
  const key=tabs.join('');
  let mult=PULL_PAYOUTS[key]||0;
  if(!mult&&tabs[0]===tabs[1]&&tabs[0]!=='❌')mult=PULL_PAYOUTS[tabs[0]+tabs[0]]||0;
  const payout=Math.round(bet*mult);
  const newCredits=user.credits-bet+payout;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(userId,'pulltab',bet,tabs.join(','),payout);
  var xp = awardXP(userId, calcXP(bet, payout, 'spin'), 'pulltab');
  var ach = trackSpin(userId, bet, payout, 'pulltab');
  res.json({tabs,win:payout,credits:newCredits,multiplier:mult,xp,achievements:ach});
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
router.get('/settings', requireAuth, (req, res) => {
  res.json({minBet:db.getSettingNum('min_bet'),maxBet:db.getSettingNum('max_bet')});
});
router.get('/public-settings', (req, res) => {
  res.json({
    rtp_slots:db.getSetting('rtp_slots'),rtp_slots_pro:db.getSetting('rtp_slots_pro'),
    rtp_crash:db.getSetting('rtp_crash'),rtp_fortune:db.getSetting('rtp_fortune'),
    rtp_nebula:db.getSetting('rtp_nebula'),rtp_ocean:db.getSetting('rtp_ocean'),
    rtp_blackjack:db.getSetting('rtp_blackjack'),rtp_roulette:db.getSetting('rtp_roulette'),
    rtp_poker:db.getSetting('rtp_poker'),rtp_pulltab:db.getSetting('rtp_pulltab'),
    minBet:db.getSettingNum('min_bet'),maxBet:db.getSettingNum('max_bet')
  });
});

// ─── FORTUNE DRAGON (5×3 canvas slots) ───────────────────────────────────────
//
// THREE-LEVER RTP SYSTEM:
//   Lever 1 — Symbol weights:   high-pay symbols (SEVEN, DIAMOND) become rarer
//   Lever 2 — Pay scale factor: even on a hit, wins pay less at lower RTP
//   Lever 3 — Jackpot contrib:  higher house edge = slower jackpot growth
//
const DELUXE_SYMS = ['SEVEN','DIAMOND','CROWN','BELL','BAR','CHERRY','WILD','SCATTER'];
const DELUXE_PAYS_BASE = {
  SEVEN:   {3:50,  4:200, 5:1000, jackpotType:'grand'},
  DIAMOND: {3:20,  4:75,  5:350,  jackpotType:'major'},
  CROWN:   {3:12,  4:45,  5:180,  jackpotType:'mini'},
  BELL:    {3:8,   4:28,  5:90},
  BAR:     {3:5,   4:15,  5:55},
  CHERRY:  {3:3,   4:8,   5:22},
  WILD:    {3:10,  4:30,  5:120},
  SCATTER: {3:null,4:null,5:null}
};
const DELUXE_LINES=[
  [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],
  [0,1,2,1,0],[2,1,0,1,2],[0,0,1,2,2],[2,2,1,0,0]
];

function getDeluxeWeights(rtp) {
  // At rtp=99: SEVEN weight~4, CHERRY~18. At rtp=50: SEVEN→0, CHERRY→40+
  const edge = 100 - rtp; // 0 at 100% rtp, 50 at 50% rtp
  return [
    Math.max(1, Math.round(4   - edge * 0.05)),  // SEVEN   (jackpot sym, rarest)
    Math.max(1, Math.round(9   - edge * 0.10)),  // DIAMOND (jackpot sym)
    Math.max(2, Math.round(12  - edge * 0.05)),  // CROWN   (jackpot sym)
    Math.max(4, Math.round(14  + edge * 0.03)),  // BELL
    Math.max(4, Math.round(14  + edge * 0.03)),  // BAR
    Math.max(8, Math.round(18  + edge * 0.12)),  // CHERRY  (most common, grows with edge)
    Math.max(1, Math.round(7   - edge * 0.05)),  // WILD
    Math.max(1, Math.round(4   - edge * 0.04)),  // SCATTER
  ];
}

// Pay scale: rtp=99→1.0, rtp=80→0.6, rtp=50→0.0 (floored at 0.25)
function getDeluxePayScale(rtp) {
  return Math.max(0.25, (rtp - 50) / 49);
}

function spin5x3(weights) {
  return Array.from({length:5},()=>Array.from({length:3},()=>weightedPick(DELUXE_SYMS,weights)));
}

function evalDeluxe(grid, bet, rtp) {
  let totalPayout = 0;
  let jackpotWin = null;
  const scatters = grid.flat().filter(s=>s==='SCATTER').length;
  const payScale = getDeluxePayScale(rtp);
  const j = getJackpots();
  const seeds = getJackpotSeeds();

  DELUXE_LINES.forEach(line => {
    const lineSyms = line.map((row,col)=>grid[col][row]);
    const first = lineSyms[0]==='WILD' ? (lineSyms.find(s=>s!=='WILD')||'WILD') : lineSyms[0];
    if (first==='SCATTER') return;
    let streak=0;
    for(const s of lineSyms){if(s===first||s==='WILD')streak++;else break;}
    if(streak>=3){
      const pays=DELUXE_PAYS_BASE[first];
      if(pays&&pays[streak]){
        // Lever 2: scale the payout by RTP factor
        const scaledMult = Math.max(1, Math.round(pays[streak] * payScale));
        const linePay = Math.round(bet * scaledMult);
        // Jackpot: 5-of-a-kind on a jackpot symbol → award jackpot pool, ignore line pay
        if(pays.jackpotType && streak===5 && !jackpotWin){
          setJackpot(pays.jackpotType, seeds[pays.jackpotType]);
          jackpotWin = {type:pays.jackpotType, win:j[pays.jackpotType]};
          totalPayout = jackpotWin.win;
          return; // skip adding linePay — jackpot overrides
        }
        if(!jackpotWin) totalPayout += linePay;
      }
    }
  });

  // Lever 3: jackpot contribution rate (higher edge = more taken, slower jackpot growth)
  if(!jackpotWin){
    const edgeFrac=(100-rtp)/100;
    const baseRate=0.003;
    const j2=getJackpots();
    setJackpot('mini',  Math.round(j2.mini  + bet*(baseRate+edgeFrac*0.002)));
    setJackpot('major', Math.round(j2.major + bet*(baseRate+edgeFrac*0.005)));
    setJackpot('grand', Math.round(j2.grand + bet*(baseRate+edgeFrac*0.01)));
  }

  return {totalPayout, jackpotWin, scatters};
}

router.post('/spin-deluxe', requireAuth, (req, res) => {
  const userId=req.session.userId;
  const minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const bet=Math.round(parseFloat(req.body.bet||minBet));
  if(bet<minBet||bet>maxBet) return res.status(400).json({error:`Bet $${(minBet/100).toFixed(2)}–$${(maxBet/100).toFixed(2)}`});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user||user.credits<bet) return res.status(400).json({error:'Insufficient credits'});

  const rtp = getSetting('rtp_fortune') || 92;
  const weights=getDeluxeWeights(rtp);
  const grid=spin5x3(weights);
  const{totalPayout,jackpotWin,scatters}=evalDeluxe(grid,bet,rtp);

  const newCredits=user.credits-bet+totalPayout;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(
    userId,'fortune',bet,grid.map(col=>col.join('|')).join(','),totalPayout
  );
  var fdXp = calcXP(bet, totalPayout, 'spin');
  if (jackpotWin) fdXp += XP_REWARDS.jackpot;
  var xp = awardXP(userId, fdXp, 'fortune');
  var ach = trackSpin(userId, bet, totalPayout, 'fortune');
  if (jackpotWin && achievementsModule) { try { achievementsModule.checkJackpot(userId, jackpotWin.type); } catch(e){} }
  const j=getJackpots();
  res.json({grid,win:totalPayout,credits:newCredits,jackpot:jackpotWin,scatters,jackpots:{mini:j.mini,major:j.major,grand:j.grand},xp,achievements:ach});
});

// ─── NEBULA BOTS (5×3 + Boost Meter) ────────────────────────────────────────
//
// TWO-LEVER RTP SYSTEM:
//   Lever 1 — Symbol weights: alien symbols (high pay) rarer at lower RTP
//   Lever 2 — Pay scale factor: wins pay less at lower RTP
//   Bonus: boost activation probability also scales with RTP
//
const NEBULA_SYMS=['ALIEN_R','ALIEN_B','ALIEN_G','WILD','SCATTER','ROCK1','ROCK2','ROCK3','ROCK4','ROCK5'];
const NEBULA_PAYS={
  ALIEN_R:{3:20,4:60,5:200}, ALIEN_B:{3:15,4:40,5:120}, ALIEN_G:{3:10,4:25,5:80},
  WILD:{3:25,4:100,5:500},
  ROCK1:{3:4,4:10,5:30}, ROCK2:{3:3,4:8,5:22}, ROCK3:{3:2,4:6,5:18},
  ROCK4:{3:2,4:5,5:15},  ROCK5:{3:1,4:4,5:12}
};
const NEBULA_LINES=[
  [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],
  [0,0,1,2,2],[2,2,1,0,0],[1,0,0,0,1],[1,2,2,2,1],[0,1,0,1,0]
];
const BOOST_VALUES=[2,3,4,5,10];

function getNebulaWeights(rtp){
  const edge=100-rtp;
  return [
    Math.max(1, Math.round(6  - edge*0.06)),   // ALIEN_R (best pay)
    Math.max(2, Math.round(8  - edge*0.06)),   // ALIEN_B
    Math.max(3, Math.round(10 - edge*0.05)),   // ALIEN_G
    Math.max(1, Math.round(5  - edge*0.05)),   // WILD
    Math.max(1, Math.round(3  - edge*0.02)),   // SCATTER
    Math.min(35,Math.round(14 + edge*0.09)),   // ROCK1
    Math.min(35,Math.round(14 + edge*0.09)),   // ROCK2
    Math.min(35,Math.round(15 + edge*0.09)),   // ROCK3
    Math.min(30,Math.round(13 + edge*0.08)),   // ROCK4
    Math.min(30,Math.round(12 + edge*0.08)),   // ROCK5
  ];
}
function getNebulaPayScale(rtp){
  return Math.max(0.3,(rtp-50)/49);
}
function nebulaSpin5x3(weights){
  return Array.from({length:5},()=>Array.from({length:3},()=>weightedPick(NEBULA_SYMS,weights)));
}
function evalNebula(grid,bet,multiplier,isFree,rtp){
  let totalPay=0;
  const boostChance=Math.max(0.05,0.30*(rtp/96));
  const boostActive=isFree||(Math.random()<boostChance);
  const boostVal=boostActive?BOOST_VALUES[Math.floor(Math.random()*BOOST_VALUES.length)]:0;
  const payScale=getNebulaPayScale(rtp);
  let stacks=0;
  for(let col=0;col<5;col++){
    if(grid[col][0]===grid[col][1]&&grid[col][1]===grid[col][2]&&grid[col][0]!=='SCATTER')stacks++;
  }
  let newMult=isFree?multiplier:1;
  for(let i=0;i<stacks;i++)newMult+=boostActive?boostVal:1;
  if(newMult<1)newMult=1;
  const scatters=grid.flat().filter(s=>s==='SCATTER').length;
  NEBULA_LINES.forEach(line=>{
    const ls=line.map((row,c)=>grid[c][row]);
    const first=ls[0]==='WILD'?(ls.find(s=>s!=='WILD')||'WILD'):ls[0];
    if(first==='SCATTER')return;
    let streak=0;for(const s of ls){if(s===first||s==='WILD')streak++;else break;}
    if(streak>=3){
      const basePay=NEBULA_PAYS[first]?.[streak];
      if(basePay){
        const scaledPay=Math.max(1,Math.round(basePay*payScale));
        totalPay+=Math.round(bet*scaledPay);
      }
    }
  });
  const finalWin=totalPay>0?Math.round(totalPay*newMult):0;
  return{finalWin,newMult,boostActive,boostVal,scatters,stacks};
}

router.post('/spin-nebula', requireAuth, (req, res) => {
  const userId=req.session.userId;
  const minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const bet=Math.round(parseFloat(req.body.bet||minBet));
  const multiplier=Math.max(1,parseInt(req.body.multiplier||1));
  const isFree=req.body.isFree===true||req.body.isFree==='true';
  if(bet<minBet||bet>maxBet)return res.status(400).json({error:`Bet $${(minBet/100).toFixed(2)}–$${(maxBet/100).toFixed(2)}`});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user||user.credits<bet)return res.status(400).json({error:'Insufficient credits'});
  const rtp=getSetting('rtp_nebula')||94;
  const weights=getNebulaWeights(rtp);
  const grid=nebulaSpin5x3(weights);
  const{finalWin,newMult,boostActive,boostVal,scatters,stacks}=evalNebula(grid,bet,multiplier,isFree,rtp);
  const newCredits=user.credits-bet+finalWin;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(
    userId,'nebula_bots',bet,grid.map(c=>c.join('|')).join(','),finalWin
  );
  var xp = awardXP(userId, calcXP(bet, finalWin, 'spin'), 'nebula_bots');
  var ach = trackSpin(userId, bet, finalWin, 'nebula_bots');
  res.json({grid,win:finalWin,credits:newCredits,multiplier:newMult,boostActive,boostVal,scatters,stacks,xp,achievements:ach});
});

// ─── OCEAN BINGO (5×3 + Bingo Mode) ─────────────────────────────────────────
const OCEAN_SYMS=['PEARL','SHARK','TURTLE','JELLYFISH','SEAHORSE','SHELL','STARFISH','CORAL','WILD','SCATTER'];
const OCEAN_PAYS={
  PEARL:{3:8,4:20,5:60}, SHARK:{3:6,4:15,5:50}, TURTLE:{3:5,4:12,5:40},
  JELLYFISH:{3:5,4:12,5:40}, SEAHORSE:{3:3,4:8,5:25}, SHELL:{3:3,4:8,5:25},
  STARFISH:{3:2,4:5,5:15}, CORAL:{3:2,4:5,5:15}, WILD:{3:10,4:30,5:100}
};
const OCEAN_LINES=[[1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],[0,0,1,2,2],[2,2,1,0,0],[1,0,0,0,1],[1,2,2,2,1],[0,1,0,1,0]];
const OCEAN_BINGO_VALS={PEARL:[1,2,3,4,5],SHARK:[6,7,8,9,10],TURTLE:[11,12,13,14,15],JELLYFISH:[16,17,18,19,20],SEAHORSE:[21,22,23,24,25],SHELL:[26,27,28,29,30],STARFISH:[31,32,33,34,35],CORAL:[36,37,38,39,40]};

function oceanSpin5x3(rtp){
  const w=[3,4,5,6,7,9,9,10,3,2]; // PEARL..SCATTER
  if(rtp<92){w[0]=2;w[1]=3;w[7]=12;w[8]=2;}
  else if(rtp>96){w[0]=4;w[1]=5;w[8]=4;w[9]=3;}
  return Array.from({length:5},()=>Array.from({length:3},()=>weightedPick(OCEAN_SYMS,w)));
}

function evalOcean(grid,bet){
  let totalWin=0,scatters=0;
  grid.forEach(col=>col.forEach(s=>{if(s==='SCATTER')scatters++;}));
  OCEAN_LINES.forEach(line=>{
    const syms=line.map((row,col)=>grid[col][row]);
    const first=syms[0]==='WILD'?(syms.find(s=>s!=='WILD')||'WILD'):syms[0];
    if(first==='SCATTER')return;
    let streak=0;for(const s of syms){if(s===first||s==='WILD')streak++;else break;}
    if(streak>=3&&OCEAN_PAYS[first]){totalWin+=Math.round(bet*OCEAN_PAYS[first][streak]/10);}
  });
  return{totalWin,scatters};
}

router.post('/spin-ocean', requireAuth, (req, res) => {
  const userId=req.session.userId;
  const minBet=getSetting('min_bet'),maxBet=getSetting('max_bet');
  const bet=Math.round(parseFloat(req.body.bet||minBet));
  const mode=req.body.mode||'slots';
  if(bet<minBet||bet>maxBet)return res.status(400).json({error:`Bet $${(minBet/100).toFixed(2)}–$${(maxBet/100).toFixed(2)}`});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user||user.credits<bet)return res.status(400).json({error:'Insufficient credits'});
  const rtp=getSetting('rtp_ocean')||94;
  const grid=oceanSpin5x3(rtp);
  const{totalWin,scatters}=evalOcean(grid,bet);

  // Bingo daubs - find matching numbers on the visible grid
  let bingoDaubs=[];
  if(mode==='bingo'&&req.body.bingoCard){
    const card=req.body.bingoCard;
    const daubed=req.body.bingoDaubed||[];
    grid.forEach(col=>col.forEach(sym=>{
      if(OCEAN_BINGO_VALS[sym]){
        const vals=OCEAN_BINGO_VALS[sym];
        const pick=vals[Math.floor(Math.random()*vals.length)];
        if(card.includes(pick)){bingoDaubs.push(pick);}
      }
    }));
  }

  // Check for bingo win
  let bingoWin=null;
  if(mode==='bingo'&&req.body.bingoCard&&req.body.bingoPattern){
    const card=req.body.bingoCard;
    const daubed=[...(req.body.bingoDaubed||[])];
    bingoDaubs.forEach(n=>{const idx=card.indexOf(n);if(idx!==-1)daubed[idx]=true;});
    const patMults={line:25,corners:15,diagonal:20,x_pattern:40,fullcard:100};
    const pat=req.body.bingoPattern;
    const mult=patMults[pat]||25;
    let won=false;
    const gc=(c,r)=>daubed[c*5+r];
    if(pat==='line'){for(let r=0;r<5;r++){if([0,1,2,3,4].every(c=>gc(c,r))){won=true;break;}}if(!won)for(let c=0;c<5;c++){if([0,1,2,3,4].every(r=>gc(c,r))){won=true;break;}}}
    else if(pat==='corners'){won=gc(0,0)&&gc(4,0)&&gc(0,4)&&gc(4,4);}
    else if(pat==='diagonal'){won=[0,1,2,3,4].every(i=>gc(i,i))||[0,1,2,3,4].every(i=>gc(i,4-i));}
    else if(pat==='x_pattern'){won=[0,1,2,3,4].every(i=>gc(i,i))&&[0,1,2,3,4].every(i=>gc(i,4-i));}
    else if(pat==='fullcard'){won=daubed.every(d=>d);}
    if(won)bingoWin={pattern:pat,amount:Math.round(bet*mult)};
  }

  const extraWin=bingoWin?bingoWin.amount:0;
  const finalWin=totalWin+extraWin;
  const newCredits=user.credits-bet+finalWin;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(newCredits,userId);
  db.prepare('INSERT INTO spins(user_id,game,bet,result,payout) VALUES(?,?,?,?,?)').run(
    userId,'ocean_bingo',bet,grid.map(c=>c.join('|')).join(','),finalWin
  );
  var xp = awardXP(userId, calcXP(bet, finalWin, 'spin'), 'ocean_bingo');
  var ach = trackSpin(userId, bet, finalWin, 'ocean_bingo');
  const jp=getJackpots();
  res.json({grid,win:totalWin,credits:newCredits,scatters,jackpots:jp,bingoDaubs,bingoWin,xp,achievements:ach});
});

// Public endpoint — returns status of all games so the lobby can show/hide cards
router.get('/statuses', (req, res) => {
  const games = db.prepare('SELECT id, status FROM games').all();
  const map = {};
  games.forEach(g => map[g.id] = g.status);
  res.json({ games: map });
});

module.exports = router;
