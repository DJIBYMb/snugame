const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const rateLimit = require("express-rate-limit");

const app = express();

const DATA_DIR =
  process.env.RENDER
  ? "/opt/render/project/src/data"
  : __dirname;

if(!fs.existsSync(DATA_DIR)){
  fs.mkdirSync(DATA_DIR,{recursive:true});
}

const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "change-moi-admin";

const db = new sqlite3.Database(
  path.join(DATA_DIR,"database.sqlite")
);

const loginLimiter = rateLimit({

  windowMs:15 * 60 * 1000,

  max:10,

  message:
    "Trop de tentatives. Réessaie plus tard."

});

app.use(express.json({
  limit:"10mb"
}));

app.use(express.urlencoded({
  extended:true
}));

app.use(express.static("public"));

const uploadDir =
  path.join(DATA_DIR,"uploads");

if(!fs.existsSync(uploadDir)){
  fs.mkdirSync(uploadDir);
}

app.use(
  "/uploads",
  express.static(uploadDir)
);

const storage = multer.diskStorage({

  destination:(req,file,cb)=>{
    cb(null,uploadDir);
  },

  filename:(req,file,cb)=>{

    const ext =
      path.extname(file.originalname)
      .toLowerCase();

    cb(
      null,
      Date.now() +
      "-" +
      Math.random()
      .toString(36)
      .slice(2) +
      ext
    );

  }

});

const upload = multer({

  storage,

  limits:{
    fileSize:20 * 1024 * 1024
  },

  fileFilter:(req,file,cb)=>{

    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/jpg",
      "video/mp4"
    ];

    if(!allowed.includes(file.mimetype)){
      return cb(
        new Error(
          "Image ou MP4 seulement"
        )
      );
    }

    cb(null,true);

  }

});

app.use(session({

  store:new SQLiteStore({
    db:"sessions.sqlite",
    dir:DATA_DIR
  }),

  secret:
    process.env.SESSION_SECRET
    || "snugame-secret",

  resave:false,

  saveUninitialized:false,

  cookie:{
    maxAge:
      1000 * 60 * 60 * 24 * 30,
    sameSite:"lax"
  }

}));

function connected(req){

  return (
    req.session &&
    req.session.userId
  );

}

function isAdmin(req){

  return (
    req.query.admin === ADMIN_PASSWORD
  );

}

function run(sql,params=[]){

  return new Promise((resolve,reject)=>{

    db.run(
      sql,
      params,
      function(err){

        if(err){
          reject(err);
        }else{
          resolve(this);
        }

      }
    );

  });

}

function get(sql,params=[]){

  return new Promise((resolve,reject)=>{

    db.get(
      sql,
      params,
      (err,row)=>{

        if(err){
          reject(err);
        }else{
          resolve(row);
        }

      }
    );

  });

}

function all(sql,params=[]){

  return new Promise((resolve,reject)=>{

    db.all(
      sql,
      params,
      (err,rows)=>{

        if(err){
          reject(err);
        }else{
          resolve(rows || []);
        }

      }
    );

  });

}

function escapeHtml(text){

  return String(text || "")

    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");

}

async function donnerBadge(
  participant_id,
  badge
){

  await run(
    `
    INSERT OR IGNORE INTO player_badges(
      participant_id,
      badge
    )
    VALUES(?,?)
    `,
    [participant_id,badge]
  );

}

async function ajouterXP(
  participant_id,
  xpAjoute
){

  const stats = await get(
    `
    SELECT *
    FROM player_stats
    WHERE participant_id=?
    `,
    [participant_id]
  );

  if(!stats) return;

  const nouveauXP =
    Number(stats.xp || 0) +
    xpAjoute;

  const nouveauNiveau =
    Math.floor(nouveauXP / 100) + 1;

  await run(
    `
    UPDATE player_stats
    SET xp=?,
        niveau=?
    WHERE participant_id=?
    `,
    [
      nouveauXP,
      nouveauNiveau,
      participant_id
    ]
  );

  if(nouveauNiveau >= 10){

    await donnerBadge(
      participant_id,
      "⚡ Pro Player"
    );

  }

}

db.serialize(()=>{

  db.run(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      abonnement INTEGER DEFAULT 0,
      abonnement_expire_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tournaments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      max_teams INTEGER DEFAULT 48,
      status TEXT DEFAULT 'draft',
      champion_id INTEGER DEFAULT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS participants(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER,
      prenom TEXT,
      email TEXT,
      username TEXT,
      telephone TEXT,
      numero_serie TEXT,
      club_logo TEXT,
      preuve TEXT,
      group_name TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS matches(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER,
      round TEXT,
      group_name TEXT,
      match_order INTEGER,
      player1_id INTEGER,
      player2_id INTEGER,
      score1 INTEGER DEFAULT NULL,
      score2 INTEGER DEFAULT NULL,
      winner_id INTEGER DEFAULT NULL,
      loser_id INTEGER DEFAULT NULL,
      proof_photo TEXT,
      played INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS player_stats(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER UNIQUE,
      matchs INTEGER DEFAULT 0,
      victoires INTEGER DEFAULT 0,
      nuls INTEGER DEFAULT 0,
      defaites INTEGER DEFAULT 0,
      buts INTEGER DEFAULT 0,
      encaisses INTEGER DEFAULT 0,
      points INTEGER DEFAULT 0,
      niveau INTEGER DEFAULT 1,
      xp INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS player_badges(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER,
      badge TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(participant_id,badge)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      preuve TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS highlights(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER,
      titre TEXT,
      description TEXT,
      media_url TEXT,
      likes INTEGER DEFAULT 0,
      vues INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS highlight_comments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      highlight_id INTEGER,
      participant_id INTEGER,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS follows(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id INTEGER,
      following_participant_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(
        follower_id,
        following_participant_id
      )
    )
  `);

});

app.get("/", async (req,res)=>{

  try{

    const highlights = await all(
      `
      SELECT
        h.*,
        p.prenom
      FROM highlights h
      LEFT JOIN participants p
      ON p.id=h.participant_id
      ORDER BY
        h.likes DESC,
        h.vues DESC,
        h.id DESC
      LIMIT 6
      `
    );

    let cards = highlights.map(h=>`

      <div class="card">

        <h3>
          🔥 ${escapeHtml(h.titre)}
        </h3>

        <p>
          <b>
            ${escapeHtml(h.prenom || "Joueur")}
          </b>
          a publié un nouveau highlight
        </p>

        <p>
          ${escapeHtml(h.description || "")}
        </p>

        ${
          h.media_url.endsWith(".mp4")
          ? `
            <video
              controls
              style="
                width:100%;
                border-radius:12px;
              ">
              <source src="${h.media_url}">
            </video>
          `
          : `
            <img
              src="${h.media_url}"
              style="
                width:100%;
                border-radius:12px;
              ">
          `
        }

        <p>
          ❤️ ${h.likes}
          • 👀 ${h.vues}
        </p>

      </div>

    `).join("");

    res.send(`

<!DOCTYPE html>
<html lang="fr">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0">

<title>SNUGAME</title>

<style>

body{
  margin:0;
  font-family:Arial,sans-serif;
  background:
    linear-gradient(
      180deg,
      #050816,
      #07111f
    );
  color:white;
}

.hero{
  padding:60px 20px;
  text-align:center;
  background:
    linear-gradient(
      135deg,
      #1455ff,
      #7c2cff
    );
}

.hero h1{
  font-size:50px;
  margin:0;
}

.hero p{
  color:#dbeafe;
}

.btn{
  display:inline-block;
  margin-top:20px;
  padding:14px 22px;
  border-radius:14px;
  background:#22c55e;
  color:#052e16;
  font-weight:bold;
  text-decoration:none;
}

.container{
  max-width:1200px;
  margin:auto;
  padding:20px;
}

.grid{
  display:grid;
  grid-template-columns:
    repeat(auto-fit,minmax(280px,1fr));
  gap:18px;
}

.card{
  background:#0f172a;
  border:1px solid #334155;
  border-radius:18px;
  padding:16px;
}

</style>

</head>

<body>

<section class="hero">

  <h1>SNUGAME</h1>

  <p>
    Tournois • Ranking • Highlights
    • Esport Mobile
  </p>

  <a class="btn" href="/app">
    Entrer sur la plateforme
  </a>

</section>

<div class="container">

  <h2>🔥 Top Highlights</h2>

  <div class="grid">
    ${
      cards ||
      "<p>Aucun highlight.</p>"
    }
  </div>

</div>

</body>
</html>

    `);

  }catch(e){

    console.log(e);

    res.send("Erreur accueil");

  }

});

app.get("/app",(req,res)=>{

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );

});

app.post("/register", async (req,res)=>{

  try{

    const {
      name,
      email,
      password
    } = req.body;

    if(
      !name ||
      !email ||
      !password
    ){
      return res.send(
        "Tous les champs obligatoires"
      );
    }

    const hash =
      await bcrypt.hash(password,10);

    await run(
      `
      INSERT INTO users(
        name,
        email,
        password
      )
      VALUES(?,?,?)
      `,
      [
        name.trim(),
        email.trim().toLowerCase(),
        hash
      ]
    );

    res.send("Compte créé");

  }catch(e){

    console.log(e);

    res.send("Erreur inscription");

  }

});

app.post("/login", loginLimiter, async (req,res)=>{

  try{

    const {
      email,
      password
    } = req.body;

    const user = await get(
      `
      SELECT *
      FROM users
      WHERE email=?
      `,
      [email.trim().toLowerCase()]
    );

    if(!user){
      return res.send(
        "Compte introuvable"
      );
    }

    const ok =
      await bcrypt.compare(
        password,
        user.password
      );

    if(!ok){
      return res.send(
        "Mot de passe incorrect"
      );
    }

    req.session.userId = user.id;

    res.send("Connexion réussie");

  }catch(e){

    console.log(e);

    res.send("Erreur connexion");

  }

});

app.post("/logout",(req,res)=>{

  req.session.destroy(()=>{
    res.send("Déconnexion");
  });

});

app.post("/tournoi", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send(
        "Connecte-toi"
      );
    }

    const {
      name,
      max_teams
    } = req.body;

    const maxTeams =
      Number(max_teams) || 48;

    if(
      maxTeams < 6 ||
      maxTeams > 100
    ){
      return res.send(
        "Entre 6 et 100 équipes"
      );
    }

    await run(
      `
      INSERT INTO tournaments(
        user_id,
        name,
        max_teams,
        status
      )
      VALUES(?,?,?,?)
      `,
      [
        req.session.userId,
        name,
        maxTeams,
        "draft"
      ]
    );

    res.send("Tournoi créé");

  }catch(e){

    console.log(e);

    res.send(
      "Erreur création tournoi"
    );

  }

});

app.get("/me", async (req,res)=>{

  if(!connected(req)){
    return res.json({
      connected:false
    });
  }

  const user = await get(
    `
    SELECT
      id,
      name,
      email,
      abonnement,
      abonnement_expire_at
    FROM users
    WHERE id=?
    `,
    [req.session.userId]
  );

  if(!user){
    return res.json({
      connected:false
    });
  }

  res.json(user);

});

app.post("/abonnement", async (req,res)=>{

  if(!connected(req)){
    return res.send("Connecte-toi");
  }

  await run(
    `
    UPDATE users
    SET abonnement=1,
        abonnement_expire_at=datetime('now','+30 days')
    WHERE id=?
    `,
    [req.session.userId]
  );

  res.send("Abonnement activé");

});

app.get("/tournois", async (req,res)=>{

  if(!connected(req)){
    return res.json([]);
  }

  const tournois = await all(
    `
    SELECT *
    FROM tournaments
    WHERE user_id=?
    ORDER BY id DESC
    `,
    [req.session.userId]
  );

  res.json(tournois);

});

app.post("/participant", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi");
    }

    const {
      tournament_id,
      prenom,
      email,
      username,
      telephone,
      numero_serie,
      club_logo,
      preuve
    } = req.body;

    if(!tournament_id || !prenom || !email){
      return res.send(
        "Tournoi, prénom et email obligatoires"
      );
    }

    const tournoi = await get(
      `
      SELECT max_teams
      FROM tournaments
      WHERE id=?
      `,
      [tournament_id]
    );

    const count = await get(
      `
      SELECT COUNT(*) AS total
      FROM participants
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    if(
      tournoi &&
      count.total >= tournoi.max_teams
    ){
      return res.send(
        "Maximum équipes atteint : " +
        tournoi.max_teams
      );
    }

    const result = await run(
      `
      INSERT INTO participants(
        tournament_id,
        prenom,
        email,
        username,
        telephone,
        numero_serie,
        club_logo,
        preuve
      )
      VALUES(?,?,?,?,?,?,?,?)
      `,
      [
        tournament_id,
        prenom,
        email,
        username || "",
        telephone || "",
        numero_serie || "",
        club_logo || "",
        preuve || ""
      ]
    );

    await run(
      `
      INSERT OR IGNORE INTO player_stats(
        participant_id
      )
      VALUES(?)
      `,
      [result.lastID]
    );

    res.send("Participant ajouté");

  }catch(e){

    console.log(e);
    res.send("Erreur ajout participant");

  }

});

app.get("/participants/:id", async (req,res)=>{

  const rows = await all(
    `
    SELECT *
    FROM participants
    WHERE tournament_id=?
    ORDER BY id
    `,
    [req.params.id]
  );

  res.json(rows);

});

app.post("/reset-tournoi", async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    await run(
      `
      DELETE FROM matches
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    await run(
      `
      UPDATE participants
      SET group_name=NULL
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    await run(
      `
      UPDATE tournaments
      SET status='draft',
          champion_id=NULL
      WHERE id=?
      `,
      [tournament_id]
    );

    res.send("Tournoi réinitialisé");

  }catch(e){

    console.log(e);

    res.send("Erreur reset tournoi");

  }

});

async function classementPoules(tournament_id){

  const teams = await all(
    `
    SELECT *
    FROM participants
    WHERE tournament_id=?
    `,
    [tournament_id]
  );

  const matches = await all(
    `
    SELECT *
    FROM matches
    WHERE tournament_id=?
    AND round='POULE'
    `,
    [tournament_id]
  );

  const table = {};

  for(const t of teams){

    table[t.id] = {
      id:t.id,
      prenom:t.prenom,
      group_name:t.group_name,
      pts:0,
      j:0,
      v:0,
      n:0,
      d:0,
      bp:0,
      bc:0,
      diff:0
    };

  }

  for(const m of matches){

    if(m.played !== 1){
      continue;
    }

    const a = table[m.player1_id];
    const b = table[m.player2_id];

    if(!a || !b){
      continue;
    }

    const s1 = Number(m.score1);
    const s2 = Number(m.score2);

    a.j++;
    b.j++;

    a.bp += s1;
    a.bc += s2;

    b.bp += s2;
    b.bc += s1;

    if(s1 > s2){

      a.v++;
      b.d++;

      a.pts += 3;

    }else if(s2 > s1){

      b.v++;
      a.d++;

      b.pts += 3;

    }else{

      a.n++;
      b.n++;

      a.pts++;
      b.pts++;

    }

  }

  const groups = {};

  for(const t of Object.values(table)){

    t.diff = t.bp - t.bc;

    const g =
      t.group_name || "Sans groupe";

    if(!groups[g]){
      groups[g] = [];
    }

    groups[g].push(t);

  }

  for(const g in groups){

    groups[g].sort((a,b)=>

      b.pts - a.pts ||

      b.diff - a.diff ||

      b.bp - a.bp

    );

  }

  return groups;

}

app.get("/classement-poules/:id", async (req,res)=>{

  try{

    const classement =
      await classementPoules(
        req.params.id
      );

    res.json(classement);

  }catch(e){

    console.log(e);

    res.json({});

  }

});

app.post("/update-match-proof", async (req,res)=>{

  try{

    const {
      match_id,
      score1,
      score2,
      photo_url
    } = req.body;

    const match = await get(
      `
      SELECT *
      FROM matches
      WHERE id=?
      `,
      [match_id]
    );

    if(!match){
      return res.send(
        "Match introuvable"
      );
    }

    if(match.locked === 1){
      return res.send(
        "Score verrouillé"
      );
    }

    const s1 = Number(score1);
    const s2 = Number(score2);

    if(
      Number.isNaN(s1) ||
      Number.isNaN(s2)
    ){
      return res.send(
        "Score invalide"
      );
    }

    if(
      match.round !== "POULE" &&
      s1 === s2
    ){
      return res.send(
        "Match nul interdit"
      );
    }

    let winner = null;
    let loser = null;

    if(s1 > s2){

      winner = match.player1_id;
      loser = match.player2_id;

    }

    if(s2 > s1){

      winner = match.player2_id;
      loser = match.player1_id;

    }

    await run(
      `
      UPDATE matches
      SET
        score1=?,
        score2=?,
        proof_photo=?,
        winner_id=?,
        loser_id=?,
        played=1
      WHERE id=?
      `,
      [
        s1,
        s2,
        photo_url || "",
        winner,
        loser,
        match_id
      ]
    );

    await ajouterXP(
      match.player1_id,
      5
    );

    await ajouterXP(
      match.player2_id,
      5
    );

    if(winner){

      await ajouterXP(
        winner,
        10
      );

      await donnerBadge(
        winner,
        "🔥 Winner"
      );

    }

    res.send(
      "Score validé + XP ajouté"
    );

  }catch(e){

    console.log(e);

    res.send(
      "Erreur validation score"
    );

  }

});

app.post("/annuler-score", async (req,res)=>{

  try{

    const { match_id } = req.body;

    const match = await get(
      `
      SELECT *
      FROM matches
      WHERE id=?
      `,
      [match_id]
    );

    if(!match){
      return res.send("Match introuvable");
    }

    if(match.locked === 1){
      return res.send("Score verrouillé impossible");
    }

    await run(
      `
      UPDATE matches
      SET score1=NULL,
          score2=NULL,
          winner_id=NULL,
          loser_id=NULL,
          proof_photo='',
          played=0
      WHERE id=?
      `,
      [match_id]
    );

    res.send("Score annulé");

  }catch(e){

    console.log(e);
    res.send("Erreur annulation score");

  }

});

function genererGroupesAuto(participants){

  const total = participants.length;

  let tailleGroupe = 4;

  if(total <= 10 || total % 4 !== 0){
    tailleGroupe = 5;
  }

  const nombreGroupes =
    Math.ceil(total / tailleGroupe);

  const groupes = [];

  const melange =
    [...participants]
    .sort(()=>Math.random() - 0.5);

  for(let i=0;i<nombreGroupes;i++){
    groupes.push([]);
  }

  let index = 0;

  for(const p of melange){

    groupes[index].push(p);

    index++;

    if(index >= groupes.length){
      index = 0;
    }

  }

  return groupes;

}

app.post("/custom-auto-draw", async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    const participants = await all(
      `
      SELECT *
      FROM participants
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    if(participants.length < 6){
      return res.send("Minimum 6 équipes");
    }

    if(participants.length > 100){
      return res.send("Maximum 100 équipes");
    }

    const existingMatches = await all(
      `
      SELECT *
      FROM matches
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    // PREMIER TIRAGE

    if(existingMatches.length === 0){

      const groupes =
        genererGroupesAuto(participants);

      const lettres =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

      for(let g=0; g<groupes.length; g++){

        const nomGroupe =
          lettres[g];

        const equipes =
          groupes[g];

        for(const equipe of equipes){

          await run(
            `
            UPDATE participants
            SET group_name=?
            WHERE id=?
            `,
            [nomGroupe,equipe.id]
          );

        }

        let ordre = 1;

        for(let i=0;i<equipes.length;i++){

          for(let j=i+1;j<equipes.length;j++){

            await run(
              `
              INSERT INTO matches(
                tournament_id,
                round,
                group_name,
                match_order,
                player1_id,
                player2_id
              )
              VALUES(?,?,?,?,?,?)
              `,
              [
                tournament_id,
                "POULE",
                nomGroupe,
                ordre,
                equipes[i].id,
                equipes[j].id
              ]
            );

            ordre++;

          }

        }

      }

      await run(
        `
        UPDATE tournaments
        SET status='active'
        WHERE id=?
        `,
        [tournament_id]
      );

      return res.send(
        "✅ Poules générées automatiquement"
      );

    }

    // VERIFICATION POULES

    const poules =
      existingMatches.filter(
        m => m.round === "POULE"
      );

    if(
      poules.length > 0 &&
      poules.some(m => m.played !== 1)
    ){
      return res.send(
        "Finis tous les scores des poules"
      );
    }

    // PHASE FINALE

    const phaseExiste =
      existingMatches.some(
        m => m.round !== "POULE"
      );

    if(!phaseExiste){

      const classement =
        await classementPoules(
          tournament_id
        );

      let qualifies = [];

      for(
        const groupe of
        Object.keys(classement)
      ){

        if(groupe === "Sans groupe"){
          continue;
        }

        const equipes =
          classement[groupe];

        if(equipes[0]){
          qualifies.push(equipes[0]);
        }

        if(equipes[1]){
          qualifies.push(equipes[1]);
        }

      }

      qualifies.sort((a,b)=>

        b.pts - a.pts ||

        b.diff - a.diff ||

        b.bp - a.bp

      );

      const tailles = [
        64,32,16,8,4,2
      ];

      let taille = 2;

      for(const t of tailles){

        if(qualifies.length >= t){
          taille = t;
          break;
        }

      }

      qualifies =
        qualifies.slice(0,taille);

      if(qualifies.length < 2){
        return res.send(
          "Pas assez de qualifiés"
        );
      }

      const roundName =

        taille === 64 ? "64ES" :

        taille === 32 ? "32ES" :

        taille === 16 ? "16ES" :

        taille === 8 ? "QUART" :

        taille === 4 ? "DEMI" :

        "FINALE";

      for(
        let i=0;
        i<qualifies.length;
        i+=2
      ){

        await run(
          `
          INSERT INTO matches(
            tournament_id,
            round,
            match_order,
            player1_id,
            player2_id
          )
          VALUES(?,?,?,?,?)
          `,
          [
            tournament_id,
            roundName,
            (i/2)+1,
            qualifies[i].id,
            qualifies[i+1].id
          ]
        );

      }

      await run(
        `
        UPDATE matches
        SET locked=1
        WHERE tournament_id=?
        AND round='POULE'
        `,
        [tournament_id]
      );

      return res.send(
        roundName +
        " généré automatiquement"
      );

    }
        // TOURS

    const ordre = [
      "64ES",
      "32ES",
      "16ES",
      "QUART",
      "DEMI",
      "FINALE"
    ];

    let tourActuel = null;

    for(const tour of ordre){

      if(
        existingMatches.some(
          m => m.round === tour
        )
      ){
        tourActuel = tour;
      }

    }

    if(!tourActuel){
      return res.send(
        "Aucun tour trouvé"
      );
    }

    const matchsTour =
      existingMatches.filter(
        m => m.round === tourActuel
      );

    if(
      matchsTour.some(
        m => m.played !== 1
      )
    ){
      return res.send(
        "Finis les matchs " +
        tourActuel
      );
    }

    // FINALE

    if(tourActuel === "FINALE"){

      const finale = matchsTour[0];

      const champion =

        Number(finale.score1) >
        Number(finale.score2)

        ? finale.player1_id

        : finale.player2_id;

      await run(
        `
        UPDATE tournaments
        SET status='finished',
            champion_id=?
        WHERE id=?
        `,
        [champion,tournament_id]
      );

      await run(
        `
        UPDATE matches
        SET locked=1
        WHERE tournament_id=?
        `,
        [tournament_id]
      );

      await donnerBadge(
        champion,
        "🏆 Champion"
      );

      return res.send(
        "🏆 Champion validé"
      );

    }

    // TOUR SUIVANT

    const prochain = {

      "64ES":"32ES",

      "32ES":"16ES",

      "16ES":"QUART",

      "QUART":"DEMI",

      "DEMI":"FINALE"

    };

    const gagnants = [];

    for(const m of matchsTour){

      if(
        Number(m.score1) >
        Number(m.score2)
      ){

        gagnants.push(
          m.player1_id
        );

      }else{

        gagnants.push(
          m.player2_id
        );

      }

    }

    await run(
      `
      UPDATE matches
      SET locked=1
      WHERE tournament_id=?
      AND round=?
      `,
      [tournament_id,tourActuel]
    );

    for(
      let i=0;
      i<gagnants.length;
      i+=2
    ){

      if(!gagnants[i+1]){
        continue;
      }

      await run(
        `
        INSERT INTO matches(
          tournament_id,
          round,
          match_order,
          player1_id,
          player2_id
        )
        VALUES(?,?,?,?,?)
        `,
        [
          tournament_id,
          prochain[tourActuel],
          (i/2)+1,
          gagnants[i],
          gagnants[i+1]
        ]
      );

    }

    return res.send(

      prochain[tourActuel] +

      " généré automatiquement"

    );

  }catch(e){

    console.log(e);

    res.send(
      "Erreur tirage personnalisé"
    );

  }

});

app.post("/supprimer-tournoi-complet", async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    if(!tournament_id){
      return res.send("Tournoi manquant");
    }

    await run(
      "DELETE FROM matches WHERE tournament_id=?",
      [tournament_id]
    );

    await run(
      "DELETE FROM participants WHERE tournament_id=?",
      [tournament_id]
    );

    await run(
      "DELETE FROM tournaments WHERE id=?",
      [tournament_id]
    );

    const reste = await get(
      "SELECT COUNT(*) AS total FROM tournaments"
    );

    if(reste.total === 0){

      await run(
        "DELETE FROM sqlite_sequence WHERE name='tournaments'"
      );

      await run(
        "DELETE FROM sqlite_sequence WHERE name='participants'"
      );

      await run(
        "DELETE FROM sqlite_sequence WHERE name='matches'"
      );

    }

    res.send("Tournoi supprimé complètement");

  }catch(e){

    console.log(e);
    res.send("Erreur suppression tournoi");

  }

});

app.get("/tirage/:id", async (req,res)=>{

  try{

    const rows = await all(
      `
      SELECT
        m.*,
        p1.prenom AS player1_name,
        p2.prenom AS player2_name
      FROM matches m
      LEFT JOIN participants p1
      ON p1.id=m.player1_id
      LEFT JOIN participants p2
      ON p2.id=m.player2_id
      WHERE m.tournament_id=?
      ORDER BY
        m.round,
        m.group_name,
        m.match_order
      `,
      [req.params.id]
    );

    const grouped = {};

    rows.forEach(m=>{

      const key =
        m.round === "POULE"
        ? "Groupe " + m.group_name
        : m.round;

      if(!grouped[key]){
        grouped[key] = [];
      }

      grouped[key].push(m);

    });

    res.json(
      Object.entries(grouped)
      .map(([tour,matchs])=>({
        tour,
        matchs
      }))
    );

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.listen(PORT, ()=>{

  console.log(
    "Serveur lancé sur le port " +
    PORT
  );

});