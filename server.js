const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const compression = require("compression");

const app = express();
app.use(compression());

const DATA_DIR =
  process.env.RENDER
  ? "/opt/render/project/src/data"
  : __dirname;

if(!fs.existsSync(DATA_DIR)){
  fs.mkdirSync(DATA_DIR,{recursive:true});
}

const PORT = process.env.PORT || 3000;

const transporter = nodemailer.createTransport({
  service:"gmail",
  auth:{
    user:process.env.MAIL_USER,
    pass:process.env.MAIL_PASS
  }
});

const loginLimiter = rateLimit({
  windowMs:15 * 60 * 1000,
  max:10,
  message:"Trop de tentatives. Réessaie plus tard."
});

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "change-moi-admin";

const db = new sqlite3.Database(
  path.join(DATA_DIR,"database.sqlite")
);

db.serialize(()=>{
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA cache_size = 10000");
  db.run("PRAGMA temp_store = MEMORY");
});

app.use(express.json({ limit:"20mb" }));
app.use(express.urlencoded({ extended:true }));
app.use(express.static("public"));

const uploadDir = path.join(DATA_DIR,"uploads");

if(!fs.existsSync(uploadDir)){
  fs.mkdirSync(uploadDir,{recursive:true});
}

app.use("/uploads", express.static(uploadDir));

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
      Math.random().toString(36).slice(2) +
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
      return cb(new Error("Image ou MP4 seulement"));
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
    process.env.SESSION_SECRET ||
    "snugame-secret",

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

    db.run(sql,params,function(err){

      if(err) reject(err);
      else resolve(this);

    });

  });

}

function get(sql,params=[]){

  return new Promise((resolve,reject)=>{

    db.get(sql,params,(err,row)=>{

      if(err) reject(err);
      else resolve(row);

    });

  });

}

function all(sql,params=[]){

  return new Promise((resolve,reject)=>{

    db.all(sql,params,(err,rows)=>{

      if(err) reject(err);
      else resolve(rows || []);

    });

  });

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
function escapeHtml(text){

  return String(text || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");

}

db.serialize(()=>{

  db.run(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      abonnement INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS email_codes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  CREATE INDEX IF NOT EXISTS idx_tournaments_user
  ON tournaments(user_id)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_participants_tournament
  ON participants(tournament_id)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_matches_tournament
  ON matches(tournament_id)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_matches_round
  ON matches(round)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_email_codes_email
  ON email_codes(email)
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
      UNIQUE(follower_id,following_participant_id)
    )
  `);

  db.run(`
    ALTER TABLE users
    ADD COLUMN abonnement_expire_at TEXT
  `,()=>{});

});
db.run(`
  ALTER TABLE users
  ADD COLUMN abonnement_expire_at TEXT
`,()=>{});
db.run(`
  ALTER TABLE tournaments
  ADD COLUMN join_code TEXT
`,()=>{});

db.run(`
  ALTER TABLE tournaments
  ADD COLUMN group_link TEXT
`,()=>{});

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
      ORDER BY h.likes DESC, h.vues DESC, h.id DESC
      LIMIT 6
      `
    );

    const cards = highlights.map(h=>`
      <div class="card">
        <h3>🔥 ${escapeHtml(h.titre)}</h3>
        <p>
          <b>${escapeHtml(h.prenom || "Joueur")}</b>
          a publié un nouveau highlight
        </p>
        <p>${escapeHtml(h.description || "")}</p>
        <a href="${escapeHtml(h.media_url)}" target="_blank">
          Voir highlight
        </a>
        <p>❤️ ${h.likes} • 👀 ${h.vues}</p>
      </div>
    `).join("");

    res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SNUGAME</title>
<style>
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:linear-gradient(180deg,#050816,#07111f);
  color:w
  hite;
}
.hero{
  padding:60px 20px;
  text-align:center;
  background:linear-gradient(135deg,#1455ff,#7c2cff);
}
.hero h1{
  font-size:46px;
  margin:0;
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
  max-width:1100px;
  margin:auto;
  padding:20px;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
  gap:15px;
}
.card{
  background:#0f172a;
  border:1px solid #334155;
  border-radius:18px;
  padding:16px;
}
a{
  color:#60a5fa;
}
</style>
</head>
<body>

<section class="hero">
  <h1>SNUGAME</h1>
  <p>Tournois • Ranking • Highlights • Esport Mobile</p>
  <a class="btn" href="/app">Entrer sur la plateforme</a>
</section>

<div class="container">
  <h2>🔥 Top Highlights</h2>
  <div class="grid">
    ${cards || "<p>Aucun highlight pour le moment.</p>"}
  </div>
</div>

</body>
</html>
    `);

  }catch(e){

    console.log(e);

    res.sendFile(
      path.join(__dirname,"public","index.html")
    );

  }

});

app.get("/app",(req,res)=>{
  res.sendFile(
    path.join(__dirname,"public","index.html")
  );
});

app.post("/send-code", async (req,res)=>{

  try{

    const { email } = req.body;

    if(!email){
      return res.send("Email obligatoire");
    }

    const cleanEmail =
      email.trim().toLowerCase();

    const existe = await get(
      `
      SELECT id
      FROM users
      WHERE email=?
      `,
      [cleanEmail]
    );

    if(existe){
      return res.send("Email déjà utilisé");
    }

    const code =
      Math.floor(
        100000 + Math.random() * 900000
      ).toString();

    await run(
      `
      INSERT INTO email_codes(
        email,
        code
      )
      VALUES(?,?)
      `,
      [
        cleanEmail,
        code
      ]
    );

    await transporter.sendMail({
      from:process.env.MAIL_USER,
      to:cleanEmail,
      subject:"Code de validation SNUGAME",
      text:"Votre code de validation SNUGAME est : " + code
    });

    res.send("Code envoyé");

  }catch(e){

    console.log(e);
    res.send("Erreur envoi code");

  }

});

app.post("/register", async (req,res)=>{

  try{

    console.log("JOIN BODY:", req.body);

    const {
      name,
      email,
      password,
      code
    } = req.body;

    if(!name || !email || !password || !code){
      return res.send(
        "Tous les champs sont obligatoires"
      );
    }

    const cleanEmail =
      email.trim().toLowerCase();

    const verification = await get(
      `
      SELECT *
      FROM email_codes
      WHERE email=?
      AND code=?
      ORDER BY id DESC
      `,
      [
        cleanEmail,
        code.trim()
      ]
    );

    if(!verification){
      return res.send("Code invalide");
    }

    const hash =
      await bcrypt.hash(password,10);

    db.run(
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
        cleanEmail,
        hash
      ],
      function(err){

        if(err){
          return res.send(
            "Email déjà utilisé"
          );
        }

        req.session.userId =
          this.lastID;

        res.send("Compte créé");

      }
    );

  }catch(e){

    console.log(e);
    res.send("Erreur inscription");

  }

});

app.post("/login", loginLimiter, (req,res)=>{

  const { email,password } = req.body;

  if(!email || !password){
    return res.send(
      "Email et mot de passe obligatoires"
    );
  }

  db.get(
    `
    SELECT *
    FROM users
    WHERE email=?
    `,
    [email.trim().toLowerCase()],
    async (err,user)=>{

      if(!user){
        return res.send("Compte introuvable");
      }

      const ok =
        await bcrypt.compare(
          password,
          user.password
        );

      if(!ok){
        return res.send("Mot de passe incorrect");
      }

      req.session.userId = user.id;

      res.send("Connexion réussie");

    }
  );

});

app.post("/logout",(req,res)=>{

  req.session.destroy(()=>{
    res.send("Déconnexion");
  });

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

  if(
    user.abonnement === 1 &&
    user.abonnement_expire_at
  ){

    const now = new Date();
    const exp =
      new Date(user.abonnement_expire_at);

    if(now > exp){

      await run(
        `
        UPDATE users
        SET abonnement=0
        WHERE id=?
        `,
        [user.id]
      );

      user.abonnement = 0;

    }

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
function generateJoinCode(){

  return Math.random()
    .toString(36)
    .substring(2,10)
    .toUpperCase();

}

app.post("/tournoi", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi d'abord");
    }

    const user = await get(
      `
      SELECT *
      FROM users
      WHERE id=?
      `,
      [req.session.userId]
    );

    if(!user){
      return res.send("Utilisateur introuvable");
    }

  const {
    name,
    max_teams,
    group_link
  } = req.body;

    if(!name){
      return res.send("Nom tournoi obligatoire");
    }

    const maxTeams =
      Number(max_teams) || 48;

    if(maxTeams < 6 || maxTeams > 100){
      return res.send("Nombre équipes entre 6 et 100");
    }

    if(
      maxTeams > 20 &&
      user.abonnement !== 1
    ){
      return res.send(
        "Abonnement requis pour créer un tournoi de plus de 20 équipes"
      );
    }

    const actifs = await get(
      `
      SELECT COUNT(*) AS total
      FROM tournaments
      WHERE user_id=?
      AND status!='finished'
      `,
      [req.session.userId]
    );

    if(
      user.abonnement !== 1 &&
      actifs.total >= 1
    ){
      return res.send(
        "Abonnement requis pour organiser plusieurs tournois en même temps"
      );
    }

    await run(
      `
      INSERT INTO tournaments(
  user_id,
  name,
  max_teams,
  status,
  join_code,
  group_link
)
VALUES(?,?,?,?,?,?)
        
        
        
        
      
      
      `,
  [
   req.session.userId,
   name,
   maxTeams,
   "draft",
   generateJoinCode(),
    group_link || ""
 ]
        
        
        
        
      
    );

    res.send("Tournoi créé");

  }catch(e){

    console.log(e);
    res.send("Erreur création tournoi");

  }

});

app.get("/tournois",(req,res)=>{

  if(!connected(req)){
    return res.json([]);
  }

  db.all(
    `
    SELECT *
    FROM tournaments
    WHERE user_id=?
    ORDER BY id DESC
    `,
    [req.session.userId],
    (err,rows)=>{
      res.json(rows || []);
    }
  );

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
      SELECT *
      FROM tournaments
      WHERE id=?
      `,
      [tournament_id]
    );

    if(!tournoi){
      return res.send("Tournoi introuvable");
    }

    const count = await get(
      `
      SELECT COUNT(*) AS total
      FROM participants
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    if(count.total >= tournoi.max_teams){
      return res.send(
        "Maximum " +
        tournoi.max_teams +
        " équipes atteint"
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

app.get("/participants/:id",(req,res)=>{

  db.all(
    `
    SELECT *
    FROM participants
    WHERE tournament_id=?
    ORDER BY id
    `,
    [req.params.id],
    (err,rows)=>{
      res.json(rows || []);
    }
  );

});

app.post(
"/supprimer-participants-selection",
async (req,res)=>{

  try{

    const { ids } = req.body;

    if(
      !ids ||
      !Array.isArray(ids) ||
      ids.length === 0
    ){
      return res.send("Aucun participant");
    }

    const placeholders =
      ids.map(()=>"?").join(",");

    await run(
      `
      DELETE FROM participants
      WHERE id IN (${placeholders})
      `,
      ids
    );

    res.send("Participants supprimés");

  }catch(e){

    console.log(e);
    res.send("Erreur suppression");

  }

});

app.post(
"/supprimer-tournoi-complet",
async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    if(!tournament_id){
      return res.send("Tournoi manquant");
    }

    await run(
      `
      DELETE FROM matches
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    await run(
      `
      DELETE FROM participants
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    await run(
      `
      DELETE FROM tournaments
      WHERE id=?
      `,
      [tournament_id]
    );

    const reste = await get(
      `
      SELECT COUNT(*) AS total
      FROM tournaments
      `
    );

    if(reste.total === 0){

      await run(
        `
        DELETE FROM sqlite_sequence
        WHERE name IN (
          'tournaments',
          'participants',
          'matches'
        )
        `
      );

    }

    res.send("Tournoi supprimé");

  }catch(e){

    console.log(e);
    res.send("Erreur suppression tournoi");

  }

});

app.post("/reset-tournoi", async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    if(!tournament_id){
      return res.send("Tournoi obligatoire");
    }

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

    if(Number(m.played) !== 1) continue;

    const a = table[m.player1_id];
    const b = table[m.player2_id];

    if(!a || !b) continue;

    const s1 = Number(m.score1);
    const s2 = Number(m.score2);

    if(Number.isNaN(s1) || Number.isNaN(s2)) continue;

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
      a.pts += 1;
      b.pts += 1;

    }

  }

  const groups = {};

  for(const t of Object.values(table)){

    t.diff = t.bp - t.bc;

    const g = t.group_name || "Sans groupe";

    if(!groups[g]){
      groups[g] = [];
    }

    groups[g].push(t);

  }

  for(const g in groups){

    groups[g].sort((a,b)=>

      b.pts - a.pts ||
      b.diff - a.diff ||
      b.bp - a.bp ||
      b.v - a.v ||
      a.bc - b.bc ||
      a.prenom.localeCompare(b.prenom)

    );

  }

  return groups;

}
app.get(
"/classement-poules/:id",
async (req,res)=>{

  try{

    const result =
      await classementPoules(
        req.params.id
      );

    res.json(result);

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

    if(!match_id){
      return res.send("Match obligatoire");
    }

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

    if(Number(match.locked) === 1){
      return res.send("Score verrouillé");
    }

    const s1 = Number(score1);
    const s2 = Number(score2);

    if(Number.isNaN(s1) || Number.isNaN(s2)){
      return res.send("Score invalide");
    }

    if(s1 < 0 || s2 < 0 || s1 > 100 || s2 > 100){
      return res.send("Score entre 0 et 100");
    }

    if(match.round !== "POULE" && s1 === s2){
      return res.send(
        "Match nul interdit en élimination directe"
      );
    }

    let winner = null;
    let loser = null;

    if(s1 > s2){
      winner = match.player1_id;
      loser = match.player2_id;
    }else if(s2 > s1){
      winner = match.player2_id;
      loser = match.player1_id;
    }

    await run(
      `
      UPDATE matches
      SET score1=?,
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

    if(match.player1_id){
      await ajouterXP(match.player1_id,5);
    }

    if(match.player2_id){
      await ajouterXP(match.player2_id,5);
    }

    if(winner){
      await ajouterXP(winner,10);
      await donnerBadge(winner,"🔥 Winner");
    }

    res.send("Score validé");

  }catch(e){

    console.log(e);
    res.send("Erreur validation score : " + e.message);

  }

});

app.post("/annuler-score", async (req,res)=>{

  try{

    const { match_id } = req.body;

    if(!match_id){
      return res.send("Match obligatoire");
    }

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
      return res.send(
        "Score verrouillé impossible à annuler"
      );
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

  if(total <= 10){
    tailleGroupe = 3;
  }else if(total <= 30){
    tailleGroupe = 4;
  }else{
    tailleGroupe = 5;
  }

  const nombreGroupes =
    Math.ceil(total / tailleGroupe);

  const groupes = [];

  for(let i=0;i<nombreGroupes;i++){
    groupes.push([]);
  }

  const melange =
    [...participants]
    .sort(()=>Math.random() - 0.5);

  let index = 0;

  for(const joueur of melange){

    groupes[index].push(joueur);

    index++;

    if(index >= groupes.length){
      index = 0;
    }

  }

  return groupes;

}

app.post("/tirage-automatique-poule-pro", async (req,res)=>{

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

    if(existingMatches.length === 0){

      const groupes = genererGroupesAuto(participants);
      const lettres = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

      for(let g=0; g<groupes.length; g++){

        const nomGroupe = lettres[g];
        const equipes = groupes[g];

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

        let ordreMatch = 1;

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
                ordreMatch,
                equipes[i].id,
                equipes[j].id
              ]
            );

            ordreMatch++;
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

      return res.send("✅ Poules générées automatiquement");
    }

    const poules = existingMatches.filter(m => m.round === "POULE");

    if(
      poules.length > 0 &&
      poules.some(m => Number(m.played) !== 1)
    ){
      return res.send("Finis tous les scores des poules");
    }

    const phaseExiste = existingMatches.some(m => m.round !== "POULE");

    if(!phaseExiste){

      const classement = await classementPoules(tournament_id);

      let qualifies = [];

      for(const groupe of Object.keys(classement)){

        if(groupe === "Sans groupe") continue;

        const equipes = classement[groupe];

        if(equipes && equipes[0]) qualifies.push(equipes[0]);
        if(equipes && equipes[1]) qualifies.push(equipes[1]);
      }

      qualifies.sort((a,b)=>
        b.pts - a.pts ||
        b.diff - a.diff ||
        b.bp - a.bp
      );

      const tailles = [64,32,16,8,4,2];

      let taille = 2;

      for(const t of tailles){
        if(qualifies.length >= t){
          taille = t;
          break;
        }
      }

      qualifies = qualifies.slice(0,taille);

      if(qualifies.length < 2){
        return res.send("Pas assez de qualifiés");
      }

      const roundName =
        taille === 64 ? "64ES" :
        taille === 32 ? "32ES" :
        taille === 16 ? "16ES" :
        taille === 8 ? "8ES" :
        taille === 4 ? "DEMIS" :
        "FINALE";

      for(let i=0;i<qualifies.length;i+=2){

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

      return res.send(roundName + " généré automatiquement");
    }

    const ordre = [
      "64ES",
      "32ES",
      "16ES",
      "8ES",
      "QUARTS",
      "DEMIS",
      "FINALE"
    ];

    let tourActuel = null;

    for(const tour of ordre){
      if(existingMatches.some(m => m.round === tour)){
        tourActuel = tour;
      }
    }

    if(!tourActuel){
      return res.send("Aucun tour trouvé");
    }

    const matchsTour = existingMatches.filter(
      m => m.round === tourActuel
    );

    if(matchsTour.some(m => Number(m.played) !== 1)){
      return res.send("Finis tous les matchs du tour " + tourActuel);
    }

    if(tourActuel === "FINALE"){

      const finale = matchsTour[0];

      const champion =
        Number(finale.score1) > Number(finale.score2)
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

      await donnerBadge(champion,"🏆 Champion");

      return res.send("Champion validé 🏆");
    }

    const prochain = {
      "64ES":"32ES",
      "32ES":"16ES",
      "16ES":"8ES",
      "8ES":"QUARTS",
      "QUARTS":"DEMIS",
      "DEMIS":"FINALE"
    };

    const gagnants = [];

    for(const m of matchsTour){

      if(Number(m.score1) > Number(m.score2)){
        gagnants.push(m.player1_id);
      }else{
        gagnants.push(m.player2_id);
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

    for(let i=0;i<gagnants.length;i+=2){

      if(!gagnants[i+1]) continue;

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
      prochain[tourActuel] + " généré automatiquement"
    );

  }catch(e){

    console.log(e);
    res.send("Erreur tirage automatique poule pro");

  }

});

app.get("/tirage/:id",(req,res)=>{

  db.all(
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
      CASE m.round
        WHEN 'POULE' THEN 1
        WHEN '64ES' THEN 2
        WHEN '32ES' THEN 3
        WHEN '16ES' THEN 4
        WHEN '8ES' THEN 5
        WHEN 'QUARTS' THEN 6
        WHEN 'DEMIS' THEN 7
        WHEN 'FINALE' THEN 8
        ELSE 99
      END,
      m.group_name,
      m.match_order
    `,
    [req.params.id],
    (err,rows)=>{

      if(err){
        return res.json([]);
      }

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

    }
  );

});

app.get("/champion/:id",(req,res)=>{

  db.get(
    `
    SELECT p.*
    FROM tournaments t
    JOIN participants p
      ON p.id=t.champion_id
    WHERE t.id=?
    `,
    [req.params.id],
    (err,row)=>{
      res.json(row || null);
    }
  );

});

app.get("/public-tournoi/:id", async (req,res)=>{

  try{

    const tournament_id = req.params.id;

    const tournoi = await get(
      `
      SELECT *
      FROM tournaments
      WHERE id=?
      `,
      [tournament_id]
    );

    if(!tournoi){
      return res.send("Tournoi introuvable");
    }

    const classement =
      await classementPoules(tournament_id);

    const matches = await all(
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
       CASE m.round
        WHEN 'POULE' THEN 1
        WHEN '64ES' THEN 2
        WHEN '32ES' THEN 3
        WHEN '16ES' THEN 4
        WHEN '8ES' THEN 5
        WHEN 'QUARTS' THEN 6
        WHEN 'DEMIS' THEN 7
        WHEN 'FINALE' THEN 8
        ELSE 99
      END,
        m.group_name,
        m.match_order
      `,
      [tournament_id]
    );

    const champion = await get(
      `
      SELECT p.*
      FROM tournaments t
      JOIN participants p
      ON p.id=t.champion_id
      WHERE t.id=?
      `,
      [tournament_id]
    ).catch(()=>null);

    const publicUrl =
      req.protocol + "://" +
      req.get("host") +
      "/public-tournoi/" +
      tournament_id;

    const qrUrl =
      "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" +
      encodeURIComponent(publicUrl);

    let html = `
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(tournoi.name)} - SNUGAME</title>
<style>
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#07111f;
  color:white;
}
header{
  background:linear-gradient(135deg,#1455ff,#7c2cff);
  padding:20px;
  text-align:center;
}
.container{
  max-width:1200px;
  margin:auto;
  padding:15px;
}
.card{
  background:#152238;
  border:1px solid #263852;
  border-radius:16px;
  padding:15px;
  margin:15px 0;
}
.match{
  background:#0f172a;
  padding:12px;
  border-radius:12px;
  margin:8px 0;
}
table{
  width:100%;
  border-collapse:collapse;
  margin-top:10px;
}
th,td{
  border:1px solid #334155;
  padding:8px;
  text-align:center;
}
th{
  background:#0b4ecb;
}
.qualifie{
  background:#064e3b;
}
button{
  padding:12px;
  border:none;
  border-radius:10px;
  background:#22c55e;
  font-weight:bold;
}
.qr{
  background:white;
  padding:10px;
  border-radius:12px;
}
@media print{
  button{
    display:none;
  }
}
</style>
</head>
<body>
<header>
<h1>${escapeHtml(tournoi.name)}</h1>
<p>Résultats publics SNUGAME</p>
<button onclick="window.print()">Exporter PDF</button>
</header>

<div class="container">
<div class="card">
<h2>QR Code</h2>
<img class="qr" src="${qrUrl}">
<p>${escapeHtml(publicUrl)}</p>
</div>
`;

    if(champion){

      html += `
<div class="card">
<h1>🏆 Champion</h1>
<h2>${escapeHtml(champion.prenom)}</h2>
<p>${escapeHtml(champion.club_logo || "")}</p>
</div>
`;

    }

    html += `
<div class="card">
<h2>Classements</h2>
`;

    for(const groupe of Object.keys(classement).sort()){

      if(groupe === "Sans groupe"){
        continue;
      }

      html += `
<h3>Groupe ${escapeHtml(groupe)}</h3>
<table>
<thead>
<tr>
<th>#</th>
<th>Équipe</th>
<th>MJ</th>
<th>V</th>
<th>N</th>
<th>D</th>
<th>BP</th>
<th>BC</th>
<th>Diff</th>
<th>Pts</th>
</tr>
</thead>
<tbody>
`;

      classement[groupe].forEach((e,i)=>{

        html += `
<tr class="${i < 2 ? "qualifie" : ""}">
<td>${i + 1}</td>
<td>${escapeHtml(e.prenom)}</td>
<td>${e.j}</td>
<td>${e.v}</td>
<td>${e.n}</td>
<td>${e.d}</td>
<td>${e.bp}</td>
<td>${e.bc}</td>
<td>${e.diff}</td>
<td><b>${e.pts}</b></td>
</tr>
`;

      });

      html += `
</tbody>
</table>
`;

    }

    html += `
</div>

<div class="card">
<h2>Matchs</h2>
`;

    let current = "";

    for(const m of matches){

      const titre =
        m.round === "POULE"
        ? "Groupe " + m.group_name
        : m.round;

      if(titre !== current){

        current = titre;

        html += `
<h3>${escapeHtml(titre)}</h3>
`;

      }

      html += `
<div class="match">
<b>
  <a
  href="/player/${m.player1_id}"
  target="_blank"
  style="color:#60a5fa;text-decoration:none;">
    ${escapeHtml(m.player1_name || "Équipe 1")}
  </a>
</b>

VS

<b>
  <a
  href="/player/${m.player2_id}"
  target="_blank"
  style="color:#60a5fa;text-decoration:none;">
    ${escapeHtml(m.player2_name || "Équipe 2")}
  </a>
</b>


<br>
${
  m.played
  ? escapeHtml(m.score1 + " - " + m.score2)
  : "Non joué"
}
${m.locked === 1 ? "<br>🔒 Verrouillé" : ""}
${
  m.proof_photo
  ? `<br><img src="${escapeHtml(m.proof_photo)}" style="max-width:100%;border-radius:10px;margin-top:10px;">`
  : ""
}
</div>
`;

    }

    html += `
</div>
</div>

<script>
setTimeout(()=>{
  location.reload();
},30000);
</script>

</body>
</html>
`;

    res.send(html);

  }catch(e){

    console.log(e);

    res.send("Erreur page publique");

  }

});

app.post("/upload-image",(req,res)=>{

  upload.single("image")(req,res,(err)=>{

    if(err){

      console.log(
        "ERREUR UPLOAD EXACTE :",
        err.message,
        err.code
      );

      return res.status(400).json({
        ok:false,
        message:err.message || "Erreur upload"
      });

    }

    if(!req.file){

      return res.status(400).json({
        ok:false,
        message:"Aucun fichier reçu"
      });

    }

    res.json({
      ok:true,
      url:"/uploads/" + req.file.filename
    });

  });

});
app.get("/player/:id", async (req,res)=>{

  try{

    const joueur = await get(
      `
      SELECT
        p.*,
        s.matchs,
        s.victoires,
        s.nuls,
        s.defaites,
        s.buts,
        s.encaisses,
        s.points,
        s.niveau,
        s.xp
      FROM participants p
      LEFT JOIN player_stats s
      ON s.participant_id=p.id
      WHERE p.id=?
      `,
      [req.params.id]
    );

    const badges = await all(
      `
      SELECT badge
      FROM player_badges
      WHERE participant_id=?
      `,
      [req.params.id]
    );

    if(!joueur){
      return res.send("Joueur introuvable");
    }

    res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(joueur.prenom)} - Carte joueur SNUGAME</title>

<style>
*{
  box-sizing:border-box;
}

body{
  margin:0;
  min-height:100vh;
  font-family:Arial,sans-serif;
  background:
    radial-gradient(circle at top left,#1455ff55,transparent 35%),
    radial-gradient(circle at top right,#7c2cff55,transparent 35%),
    linear-gradient(180deg,#050816,#07111f);
  color:white;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:20px;
}

.player-card{
  width:100%;
  max-width:420px;
  background:
    linear-gradient(160deg,#1e3a8a,#111827 45%,#020617);
  border:2px solid #60a5fa;
  border-radius:28px;
  padding:22px;
  box-shadow:
    0 0 35px #1455ff88,
    inset 0 0 25px #ffffff12;
  position:relative;
  overflow:hidden;
}

.player-card::before{
  content:"";
  position:absolute;
  inset:-40%;
  background:linear-gradient(120deg,transparent,#ffffff22,transparent);
  transform:rotate(25deg);
}

.card-content{
  position:relative;
  z-index:2;
}

.logo{
  text-align:center;
  font-weight:900;
  letter-spacing:3px;
  color:#93c5fd;
  margin-bottom:12px;
}

.player-name{
  text-align:center;
  font-size:34px;
  font-weight:900;
  margin:10px 0;
  text-transform:uppercase;
}

.level{
  text-align:center;
  font-size:18px;
  color:#fde047;
  margin-bottom:18px;
}

.avatar{
  width:120px;
  height:120px;
  margin:15px auto;
  border-radius:50%;
  background:
    linear-gradient(135deg,#1455ff,#7c2cff);
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:48px;
  font-weight:900;
  box-shadow:0 0 30px #60a5fa88;
  border:3px solid #bfdbfe;
}

.club{
  text-align:center;
  color:#cbd5e1;
  margin-bottom:18px;
}

.stats{
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:10px;
  margin:18px 0;
}

.stat{
  background:#020617cc;
  border:1px solid #334155;
  border-radius:16px;
  padding:12px;
  text-align:center;
}

.stat b{
  display:block;
  color:#93c5fd;
  font-size:20px;
}

.badges{
  background:#020617aa;
  border:1px solid #334155;
  border-radius:16px;
  padding:14px;
  margin-top:15px;
}

.badge{
  display:inline-block;
  background:#f59e0b;
  color:#111827;
  padding:8px 10px;
  border-radius:999px;
  margin:5px;
  font-weight:900;
}

button{
  width:100%;
  margin-top:14px;
  padding:13px;
  border:none;
  border-radius:16px;
  background:linear-gradient(135deg,#22c55e,#86efac);
  color:#052e16;
  font-weight:900;
  cursor:pointer;
}

.small{
  color:#cbd5e1;
  font-size:13px;
  text-align:center;
}
</style>
</head>

<body>

<button
onclick="
  if(document.referrer){
    history.back();
  }else{
    window.location.href='/app';
  }
"
style="
position:fixed;
top:15px;
left:15px;
z-index:1000;
padding:12px 18px;
border:none;
border-radius:14px;
background:linear-gradient(135deg,#2563eb,#06b6d4);
color:white;
font-weight:900;
cursor:pointer;
box-shadow:0 0 20px #1455ff88;
">
⬅ Retour
</button>

<div class="player-card">

<div class="card-content">

<div class="logo">
SNUGAME CARD
</div>

<div class="avatar">
${escapeHtml((joueur.prenom || "?").charAt(0).toUpperCase())}
</div>

<div class="player-name">
${escapeHtml(joueur.prenom)}
</div>

<div class="level">
★ Niveau ${joueur.niveau || 1}
</div>

<div class="club">
${escapeHtml(joueur.club_logo || "Club non renseigné")}
</div>

<div class="stats">

<div class="stat">
<b>${joueur.xp || 0}</b>
XP
</div>

<div class="stat">
<b>${joueur.matchs || 0}</b>
Matchs
</div>

<div class="stat">
<b>${joueur.victoires || 0}</b>
Victoires
</div>

<div class="stat">
<b>${joueur.defaites || 0}</b>
Défaites
</div>

<div class="stat">
<b>${joueur.points || 0}</b>
Points
</div>

<div class="stat">
<b>${joueur.nuls || 0}</b>
Nuls
</div>

</div>

<div class="badges">
<h3>Insignes</h3>
${
  badges.length
  ? badges.map(b=>`
      <span class="badge">
        ${escapeHtml(b.badge)}
      </span>
    `).join("")
  : "<p class='small'>Aucun badge</p>"
}
</div>

<form method="POST" action="/follow-player">
  <input type="hidden" name="participant_id" value="${joueur.id}">
  <button>Suivre ce joueur 🔥</button>
</form>

<p class="small">
Profil joueur SNUGAME eFootball Mobile
</p>

</div>

</div>

</body>
</html>
`);

  }catch(e){

    console.log(e);
    res.send("Erreur profil joueur");

  }

});

app.get("/fix-player-stats", async (req,res)=>{

  try{

    const participants =
      await all("SELECT id FROM participants");

    for(const p of participants){

      await run(
        `
        INSERT OR IGNORE INTO player_stats(
          participant_id
        )
        VALUES(?)
        `,
        [p.id]
      );

    }

    res.send("Stats joueurs réparées");

  }catch(e){

    console.log(e);
    res.send("Erreur réparation stats");

  }

});

app.get("/ranking", async (req,res)=>{

  try{

    const joueurs = await all(
      `
      SELECT
        p.id,
        p.prenom,
        s.matchs,
        s.victoires,
        s.defaites,
        s.points,
        s.niveau,
        s.xp
      FROM participants p
      LEFT JOIN player_stats s
      ON s.participant_id=p.id
      ORDER BY
        s.points DESC,
        s.victoires DESC,
        s.xp DESC
      LIMIT 100
      `
    );

    res.json(joueurs);

  }catch(e){

    console.log(e);
    res.send("Erreur ranking");

  }

});

app.get("/ranking-page", async (req,res)=>{

  try{

    const joueurs = await all(
      `
      SELECT
        p.id,
        p.prenom,
        s.matchs,
        s.victoires,
        s.defaites,
        s.points,
        s.niveau,
        s.xp
      FROM participants p
      LEFT JOIN player_stats s
      ON s.participant_id=p.id
      ORDER BY
        s.points DESC,
        s.victoires DESC,
        s.xp DESC
      LIMIT 100
      `
    );

    let html = `
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Ranking SNUGAME</title>
</head>
<body style="background:#07111f;color:white;font-family:Arial;padding:20px;">
<h1>🌍 Ranking Mondial SNUGAME</h1>
`;

    joueurs.forEach((j,i)=>{

      html += `
<div style="background:#0f172a;border:1px solid #334155;border-radius:15px;padding:15px;margin:12px 0;">
  <h2>#${i+1} ${escapeHtml(j.prenom)}</h2>
  <p>${j.points || 0} pts • ${j.victoires || 0} V • ${j.defaites || 0} D</p>
  <p>Niveau ${j.niveau || 1} • XP ${j.xp || 0}</p>
</div>
`;

    });

    html += `
</body>
</html>
`;

    res.send(html);

  }catch(e){

    console.log(e);
    res.send("Erreur ranking page");

  }

});

app.post("/preuve-paiement", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi");
    }

    const { preuve } = req.body;

    if(!preuve){
      return res.send("Preuve obligatoire");
    }

    await run(
      `
      INSERT INTO payments(
        user_id,
        preuve
      )
      VALUES(?,?)
      `,
      [
        req.session.userId,
        preuve
      ]
    );

    res.send(
      "Preuve envoyée. L’admin va vérifier ton paiement."
    );

  }catch(e){

    console.log(e);
    res.send("Erreur preuve paiement");

  }

});

app.get("/admin-payments", async (req,res)=>{

  try{

    if(!isAdmin(req)){
      return res.send("Accès admin refusé");
    }

    const paiements = await all(
      `
      SELECT
        payments.id,
        payments.user_id,
        payments.preuve,
        payments.status,
        payments.created_at,
        users.name,
        users.email,
        users.abonnement
      FROM payments
      JOIN users
      ON users.id=payments.user_id
      ORDER BY payments.id DESC
      `
    );

    let html = `
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Admin Paiements</title>
</head>
<body style="background:#07111f;color:white;font-family:Arial;padding:20px;">
<h1>Admin Paiements SNUGAME</h1>
`;

    paiements.forEach(p=>{

      html += `
<div style="background:#0f172a;border:1px solid #334155;border-radius:15px;padding:15px;margin:12px 0;">
  <h2>${escapeHtml(p.name)}</h2>
  <p>Email : ${escapeHtml(p.email)}</p>
  <p>Status : ${escapeHtml(p.status)}</p>
  <p>Abonnement : ${p.abonnement === 1 ? "Actif" : "Non actif"}</p>
  <p>
    Preuve :
    <a href="${escapeHtml(p.preuve)}" target="_blank">
      Ouvrir
    </a>
  </p>

  ${
    p.status !== "approved"
    ? `
      <form method="POST" action="/admin-valider-paiement?admin=${ADMIN_PASSWORD}">
        <input type="hidden" name="payment_id" value="${p.id}">
        <input type="hidden" name="user_id" value="${p.user_id}">
        <button>Valider abonnement 1 mois</button>
      </form>
      <form method="POST" action="/admin-refuser-paiement?admin=${ADMIN_PASSWORD}">
  <input type="hidden" name="payment_id" value="${p.id}">
  <input type="hidden" name="user_id" value="${p.user_id}">
  <button style="background:#ef4444;color:white;">
    Refuser abonnement
  </button>
</form>
    `
    : "<p>✅ Paiement déjà validé</p>"
  }
</div>
`;

    });

    html += `
</body>
</html>
`;

    res.send(html);

  }catch(e){

    console.log(e);
    res.send("Erreur admin paiements");

  }

});

app.post("/admin-valider-paiement", async (req,res)=>{

  try{

    const {
      payment_id,
      user_id
    } = req.body;

    await run(
      `
      UPDATE users
      SET abonnement=1,
          abonnement_expire_at=datetime('now','+30 days')
      WHERE id=?
      `,
      [user_id]
    );

    await run(
      `
      UPDATE payments
      SET status='approved'
      WHERE id=?
      `,
      [payment_id]
    );

    res.redirect("/admin-payments");

  }catch(e){

    console.log(e);
    res.send("Erreur validation paiement");

  }

});
app.post("/admin-refuser-paiement", async (req,res)=>{

  try{

    if(!isAdmin(req)){
      return res.send("Accès admin refusé");
    }

    const { payment_id,user_id } = req.body;

    await run(
      `
      UPDATE users
      SET abonnement=0,
          abonnement_expire_at=NULL
      WHERE id=?
      `,
      [user_id]
    );

    await run(
      `
      UPDATE payments
      SET status='refused'
      WHERE id=?
      `,
      [payment_id]
    );

    res.redirect("/admin-payments?admin=" + ADMIN_PASSWORD);

  }catch(e){

    console.log(e);
    res.send("Erreur refus paiement");

  }

});

app.get("/download-db",(req,res)=>{

  const dbPath =
    path.join(DATA_DIR,"database.sqlite");

  res.download(dbPath);

});

app.post("/highlight", async (req,res)=>{

  try{

    const {
      participant_id,
      titre,
      description,
      media_url
    } = req.body;

    if(!participant_id || !titre || !media_url){
      return res.send(
        "Participant, titre et média obligatoires"
      );
    }

    await run(
      `
      INSERT INTO highlights(
        participant_id,
        titre,
        description,
        media_url
      )
      VALUES(?,?,?,?)
      `,
      [
        participant_id,
        titre,
        description || "",
        media_url
      ]
    );

    await ajouterXP(participant_id,15);

    res.send("Highlight publié + XP ajouté");

  }catch(e){

    console.log(e);
    res.send("Erreur ajout highlight");

  }

});

app.get("/highlights", async (req,res)=>{

  try{

    const highlights = await all(
      `
      SELECT
        h.*,
        p.prenom
      FROM highlights h
      LEFT JOIN participants p
      ON p.id=h.participant_id
      ORDER BY h.id DESC
      `
    );

    res.json(highlights);

  }catch(e){

    console.log(e);
    res.send("Erreur highlights");

  }

});

app.post("/like-highlight", async (req,res)=>{

  try{

    const { id } = req.body;

    await run(
      `
      UPDATE highlights
      SET likes = likes + 1
      WHERE id=?
      `,
      [id]
    );

    res.send("Like ajouté");

  }catch(e){

    console.log(e);
    res.send("Erreur like");

  }

});

app.post("/view-highlight", async (req,res)=>{

  try{

    const { id } = req.body;

    await run(
      `
      UPDATE highlights
      SET vues = vues + 1
      WHERE id=?
      `,
      [id]
    );

    res.send("Vue ajoutée");

  }catch(e){

    console.log(e);
    res.send("Erreur vue");

  }

});

app.post("/comment-highlight", async (req,res)=>{

  try{

    const {
      highlight_id,
      participant_id,
      comment
    } = req.body;

    if(
      !highlight_id ||
      !participant_id ||
      !comment
    ){
      return res.send(
        "Informations manquantes"
      );
    }

    await run(
      `
      INSERT INTO highlight_comments(
        highlight_id,
        participant_id,
        comment
      )
      VALUES(?,?,?)
      `,
      [
        highlight_id,
        participant_id,
        comment
      ]
    );

    res.send("Commentaire ajouté");

  }catch(e){

    console.log(e);
    res.send("Erreur commentaire");

  }

});

app.get("/comments-highlight/:id", async (req,res)=>{

  try{

    const comments = await all(
      `
      SELECT
        c.*,
        p.prenom
      FROM highlight_comments c
      LEFT JOIN participants p
      ON p.id=c.participant_id
      WHERE c.highlight_id=?
      ORDER BY c.id DESC
      `,
      [req.params.id]
    );

    res.json(comments);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.post("/follow-player", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi");
    }

    const { participant_id } = req.body;

    if(!participant_id){
      return res.send("Participant manquant");
    }

    await run(
      `
      INSERT OR IGNORE INTO follows(
        follower_id,
        following_participant_id
      )
      VALUES(?,?)
      `,
      [
        req.session.userId,
        participant_id
      ]
    );

    res.send("Joueur suivi 🔥");

  }catch(e){

    console.log(e);
    res.send("Erreur follow");

  }

});

app.get("/followers/:id", async (req,res)=>{

  try{

    const result = await get(
      `
      SELECT COUNT(*) AS total
      FROM follows
      WHERE following_participant_id=?
      `,
      [req.params.id]
    );

    res.json({
      followers: result.total || 0
    });

  }catch(e){

    console.log(e);

    res.json({
      followers:0
    });

  }

});

app.post("/generer-phase-finale", async (req,res)=>{
  req.url = "/tirage-automatique-poule-pro";
  return app._router.handle(req,res);
});

app.post("/generer-tour-suivant", async (req,res)=>{
  req.url = "/tirage-automatique-poule-pro";
  return app._router.handle(req,res);
});

app.post("/valider-champion-auto", async (req,res)=>{
  req.url = "/tirage-automatique-poule-pro";
  return app._router.handle(req,res);
});
app.post("/send-reset-code", async (req,res)=>{

  try{

    const { email } = req.body;

    if(!email){
      return res.send("Email obligatoire");
    }

    const user = await get(
      `
      SELECT *
      FROM users
      WHERE email=?
      `,
      [email.trim().toLowerCase()]
    );

    if(!user){
      return res.send("Compte introuvable");
    }

    const code =
      Math.floor(
        100000 + Math.random() * 900000
      ).toString();

    await run(
      `
      INSERT INTO email_codes(
        email,
        code
      )
      VALUES(?,?)
      `,
      [
        email.trim().toLowerCase(),
        code
      ]
    );

    await transporter.sendMail({
      from:process.env.MAIL_USER,
      to:email,
      subject:"Reset mot de passe SNUGAME",
      text:"Code reset : " + code
    });

    res.send("Code envoyé");

  }catch(e){

    console.log(e);

    res.send("Erreur reset code");

  }

});
app.get("/join/:code", async (req,res)=>{

  try{

    const tournoi = await get(
      `
      SELECT *
      FROM tournaments
      WHERE join_code=?
      `,
      [req.params.code]
    );

    if(!tournoi){
      return res.send("Lien inscription invalide");
    }

    const count = await get(
      `
      SELECT COUNT(*) AS total
      FROM participants
      WHERE tournament_id=?
      `,
      [tournoi.id]
    );

    if(tournoi.status !== "draft"){
      return res.send("Les inscriptions sont fermées. Le tirage a commencé.");
    }

    if(count.total >= tournoi.max_teams){
      return res.send("Tournoi complet. Inscriptions fermées.");
    }

    res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rejoindre ${escapeHtml(tournoi.name)} - SNUGAME</title>

<style>
*{box-sizing:border-box}
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:
    radial-gradient(circle at top left,#1455ff33,transparent 35%),
    radial-gradient(circle at top right,#7c2cff33,transparent 35%),
    linear-gradient(180deg,#050816,#07111f);
  color:white;
  min-height:100vh;
}
header{
  background:linear-gradient(135deg,#1455ff,#7c2cff);
  padding:24px 18px;
  text-align:center;
  box-shadow:0 0 35px #1455ff88;
}
header h1{
  margin:0;
  font-size:34px;
  letter-spacing:3px;
}
.container{
  max-width:520px;
  margin:auto;
  padding:18px;
}
.card{
  background:linear-gradient(180deg,#0f172aee,#111c33);
  border:1px solid #334155;
  padding:22px;
  border-radius:22px;
  margin-top:22px;
  box-shadow:0 0 25px #00000055;
}
input,button{
  width:100%;
  padding:13px;
  margin:8px 0;
  border:none;
  border-radius:14px;
  font-size:15px;
}
input{
  background:#020617;
  color:white;
  border:1px solid #334155;
}
button{
  background:linear-gradient(135deg,#22c55e,#86efac);
  color:#052e16;
  font-weight:900;
  cursor:pointer;
}
.secondary{
  background:linear-gradient(135deg,#2563eb,#06b6d4);
  color:white;
}
.small{
  color:#cbd5e1;
  font-size:13px;
}
#msg{
  white-space:pre-wrap;
  background:#020617;
  padding:14px;
  border-radius:16px;
  border:1px solid #334155;
  margin-top:12px;
  color:#dbeafe;
}
</style>
</head>

<body>

<header>
  <h1>SNUGAME</h1>
  <p>Inscription tournoi eFootball Mobile</p>
</header>

<div class="container">

<div class="card">

<h2>🏆 ${escapeHtml(tournoi.name)}</h2>

<p class="small">
Places : ${count.total}/${tournoi.max_teams}
</p>

<p>
Crée ton compte SNUGAME et participe automatiquement à ce tournoi.
</p>

<input id="joinName" placeholder="Nom joueur">

<input id="joinEmail" placeholder="Adresse email">

<input id="joinPassword" type="password" placeholder="Mot de passe">

<button class="secondary" onclick="sendCode()">
Envoyer code email
</button>

<input id="joinCode" placeholder="Code reçu par email">

<button onclick="joinTournament()">
Créer compte et participer
</button>

<p id="msg"></p>

</div>

</div>

<script>
async function post(url,data){

  message.textContent =
    "⏳ Chargement...";

  try{

    const res = await fetch(url,{
      method:"POST",
      headers:{
        "Content-Type":"application/json"
      },
      body:JSON.stringify(data)
    });

    const text =
      await res.text();

    message.textContent =
      text;

    return text;

  }catch(e){

    message.textContent =
      "Erreur réseau. Réessaie.";

    return "";

  }

}

async function sendCode(){
  msg.textContent = await post("/send-code",{
    email:document.getElementById("joinEmail").value.trim()
  });
}

async function joinTournament(){

  msg.textContent = "Inscription en cours...";

  const payload = {
    join_code:"${escapeHtml(req.params.code)}",
    name:document.getElementById("joinName").value.trim(),
    email:document.getElementById("joinEmail").value.trim(),
    password:document.getElementById("joinPassword").value,
    code:document.getElementById("joinCode").value.trim()
  };

  const result = await post("/join-tournament",payload);

  msg.innerHTML = result;
}
</script>

</body>
</html>
    `);

  }catch(e){

    console.log(e);
    res.send("Erreur page inscription tournoi : " + e.message);

  }

});
app.post("/join-tournament", async (req,res)=>{

  try{

    const {
      join_code,
      name,
      email,
      password,
      code
    } = req.body;

    if(!join_code || !name || !email || !password || !code){
      return res.send("Tous les champs sont obligatoires");
    }

    const tournoi = await get(
      `
      SELECT *
      FROM tournaments
      WHERE join_code=?
      `,
      [join_code]
    );

    if(!tournoi){
      return res.send("Tournoi introuvable");
    }

    if(tournoi.status !== "draft"){
      return res.send("Les inscriptions sont fermées. Le tirage a commencé.");
    }

    const count = await get(
      `
      SELECT COUNT(*) AS total
      FROM participants
      WHERE tournament_id=?
      `,
      [tournoi.id]
    );

    if(count.total >= tournoi.max_teams){
      return res.send("Tournoi complet. Le lien est fermé.");
    }

    const cleanEmail =
      email.trim().toLowerCase();

    const verification = await get(
      `
      SELECT *
      FROM email_codes
      WHERE email=?
      AND code=?
      ORDER BY id DESC
      `,
      [
        cleanEmail,
        code.trim()
      ]
    );

    if(!verification){
      return res.send("Code invalide");
    }

    let user = await get(
      `
      SELECT *
      FROM users
      WHERE email=?
      `,
      [cleanEmail]
    );

    if(!user){

      const hash =
        await bcrypt.hash(password,10);

      const created = await run(
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
          cleanEmail,
          hash
        ]
      );

      user = {
        id:created.lastID,
        name:name.trim(),
        email:cleanEmail
      };

    }

    const already = await get(
      `
      SELECT *
      FROM participants
      WHERE tournament_id=?
      AND email=?
      `,
      [
        tournoi.id,
        cleanEmail
      ]
    );

    if(already){
      return res.send("Tu es déjà inscrit à ce tournoi");
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
        tournoi.id,
        name.trim(),
        cleanEmail,
        name.trim(),
        "",
        "",
        "",
        "Inscription lien tournoi"
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

    req.session.userId = user.id;

    res.send(`
  ✅ Inscription réussie.<br>
  Tu es ajouté automatiquement aux participants.<br>
  Attends que l'organisateur lance le tirage.<br><br>

  ${
    tournoi.group_link
    ? `
      <a
      href="${escapeHtml(tournoi.group_link)}"
      target="_blank"
      style="
        display:block;
        background:#22c55e;
        color:#052e16;
        padding:12px;
        border-radius:10px;
        text-align:center;
        font-weight:bold;
        text-decoration:none;
      ">
      Rejoindre le groupe du tournoi
      </a>
    `
    : ""
  }
`);
      
    

  }catch(e){

    console.log(e);
    
   res.send("Erreur inscription automatique tournoi : " + e.message);
  }

});

app.listen(PORT, () => {

  console.log(
    "Serveur lancé sur le port " + PORT
  );

});