const {
  initializeApp,
  cert,
  getApps
} = require("firebase-admin/app");

const {
  getMessaging
} = require("firebase-admin/messaging");
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const os = require("os");
const { execFile } = require("child_process");
const { exec } = require("child_process");

const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const compression = require("compression");
const helmet = require("helmet");

if(process.env.FIREBASE_SERVICE_ACCOUNT){

  const serviceAccount =
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  if(!getApps().length){
    initializeApp({
      credential: cert(serviceAccount)
    });
  }

}

const requiredR2 = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_URL"
];

for(const key of requiredR2){

  if(!process.env[key]){
    throw new Error(
      `Variable d'environnement manquante : ${key}`
    );
  }

}


const {
  S3Client,
  PutObjectCommand
} = require("@aws-sdk/client-s3");

const r2 = new S3Client({
  region:"auto",
  endpoint:
    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials:{
    accessKeyId:process.env.R2_ACCESS_KEY_ID,
    secretAccessKey:process.env.R2_SECRET_ACCESS_KEY
  }
});

const app = express();

app.use(
  helmet({
    contentSecurityPolicy:false,
    crossOriginResourcePolicy:false
  })
);

if(process.env.NODE_ENV === "production"){
  app.set("trust proxy", 1);
}

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
  },
  tls:{
    rejectUnauthorized:false
  }
});

const loginLimiter = rateLimit({
  windowMs:15 * 60 * 1000,
  max:10,
  message:"Trop de tentatives. Réessaie plus tard."
});

const emailCodeLimiter = rateLimit({

  windowMs: 15 * 60 * 1000,

  max: 5,

  standardHeaders: true,

  legacyHeaders: false,

  message:
    "Trop de demandes de code. Réessaie dans 15 minutes."

});

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

if(!ADMIN_PASSWORD){

  throw new Error(
    "ADMIN_PASSWORD est obligatoire."
  );

}

const SESSION_SECRET =
  process.env.SESSION_SECRET;

if(!SESSION_SECRET){

  throw new Error(
    "SESSION_SECRET est obligatoire."
  );

}

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

const storage = multer.memoryStorage();

const upload = multer({

  storage,

  limits:{
    fileSize:50 * 1024 * 1024

  },

  fileFilter:(req,file,cb)=>{

    const allowedMime = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/quicktime",
      "video/webm"
    ];

    const allowedExt = [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".mp4",
      ".mov",
      ".webm"
      
    ];

    const ext =
      path.extname(
        file.originalname
      ).toLowerCase();

    if(
      !allowedMime.includes(file.mimetype) ||
      !allowedExt.includes(ext)
    ){
      return cb(
        new Error(
          "Fichier interdit. Images JPG/PNG/WEBP ou vidéo MP4 seulement."
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

  secret: SESSION_SECRET,

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

function tr(req, fr, en){

  const langue =
    req.headers["x-language"] || "fr";

  return langue === "en" ? en : fr;

}

async function verifierProprietaireTournoi(req, tournament_id){

  if(!connected(req)){
    return {
      ok:false,
      message:"Connecte-toi"
    };
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
    return {
      ok:false,
      message:"Tournoi introuvable"
    };
  }

  if(Number(tournoi.user_id) !== Number(req.session.userId)){
    return {
      ok:false,
      message:"Accès refusé : seul le propriétaire du tournoi peut modifier"
    };
  }

  return {
    ok:true,
    tournoi
  };

}

function isAdmin(req){

  return Boolean(
    req.session &&
  
    req.session.isAdmin === true

  );

}

app.get("/admin-login",(req,res)=>{

  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1">
<title>Administration SNUGAME</title>
</head>

<body style="
  background:#07111f;
  color:white;
  font-family:Arial;
  padding:25px;
">

<h1>Administration SNUGAME</h1>

<form method="POST" action="/admin-login">

  <input
    type="password"
    name="password"
    placeholder="Mot de passe administrateur"
    required
    style="
      width:100%;
      max-width:420px;
      padding:14px;
      margin:10px 0;
    ">

  <button
    type="submit"
    style="
      display:block;
      padding:14px 20px;
      margin-top:10px;
    ">
    Connexion
  </button>

</form>

</body>
</html>
  `);

});

app.post("/admin-login", loginLimiter, (req,res)=>{

  const password =
    String(req.body.password || "");

  if(password !== ADMIN_PASSWORD){

    return res
      .status(403)
      .send("Mot de passe administrateur incorrect");

  }

  req.session.regenerate(error=>{

    if(error){

      return res
        .status(500)
        .send("Erreur création session admin");

    }

    req.session.isAdmin = true;

    return res.redirect(
      "/admin-payments"
    );

  });

});

app.post("/admin-logout",(req,res)=>{

  if(req.session){
    req.session.isAdmin = false;
  }

  return res.redirect(
    "/admin-login"
  );

});

function run(sql,params=[]){

  return new Promise((resolve,reject)=>{

    db.run(sql,params,function(err){

      if(err) reject(err);
      else resolve(this);

    });

  });

}

async function envoyerNotificationPush(token, titre, message){

  try{

    await getMessaging().send({
      token,
      notification:{
        title:titre,
        body:message
      },
      android:{
        priority:"high",
        notification:{
          sound:"default"
        }
      }
    });

  }catch(e){

    console.log("Erreur FCM :", e);

  }

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
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_matches_tournament
  ON matches(tournament_id)
  `);

  db.run(`
  CREATE INDEX IF NOT EXISTS idx_participants_tournament
  ON participants(tournament_id)
 `);

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
db.run(`
  ALTER TABLE users
  ADD COLUMN banned INTEGER DEFAULT 0
`,()=>{});
db.run(`
  ALTER TABLE users
  ADD COLUMN world_points INTEGER DEFAULT 0
`,()=>{});

db.run(`
  ALTER TABLE users
  ADD COLUMN world_wins INTEGER DEFAULT 0
`,()=>{});

db.run(`
  ALTER TABLE users
  ADD COLUMN world_losses INTEGER DEFAULT 0
`,()=>{});

db.run(`
  ALTER TABLE users
  ADD COLUMN world_goals INTEGER DEFAULT 0
`,()=>{});

db.run(`
  ALTER TABLE users
  ADD COLUMN world_titles INTEGER DEFAULT 0
`,()=>{});
db.run(`
  ALTER TABLE tournaments
  ADD COLUMN status TEXT DEFAULT 'draft'
`,()=>{});
db.run(`
  ALTER TABLE participants
  ADD COLUMN group_name TEXT
`,()=>{});

db.run(`
  ALTER TABLE matches
  ADD COLUMN locked INTEGER DEFAULT 0
`,()=>{});
db.run(`
  ALTER TABLE matches
  ADD COLUMN journee TEXT
`,()=>{});
db.run(`
  ALTER TABLE matches
  ADD COLUMN penalty1 INTEGER DEFAULT NULL
`,()=>{});

db.run(`
  ALTER TABLE matches
  ADD COLUMN penalty2 INTEGER DEFAULT NULL
`,()=>{});

db.run(`
  ALTER TABLE users
  ADD COLUMN profile_photo TEXT
`,()=>{});
db.run(`
  ALTER TABLE participants
  ADD COLUMN user_id INTEGER
`,()=>{});
db.run(`
  ALTER TABLE users
  ADD COLUMN username TEXT
`,()=>{});

db.run(`
  ALTER TABLE users
  ADD COLUMN username_updated_at TEXT
`,()=>{});

db.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
  ON users(username)
`);
db.run(`
  ALTER TABLE users
  ADD COLUMN username TEXT
`,()=>{});

db.run(`
  ALTER TABLE users
  ADD COLUMN username_updated_at TEXT
`,()=>{});
db.run(`
  ALTER TABLE users
  ADD COLUMN username TEXT
`,()=>{});

db.run(`
  ALTER TABLE users
  ADD COLUMN username_updated_at TEXT
`,()=>{});
db.run(`
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  message TEXT,
  seen INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
  ALTER TABLE highlights
  ADD COLUMN user_id INTEGER
`,()=>{});
db.run(`
  ALTER TABLE highlights
  ADD COLUMN thumbnail_url TEXT
`, err=>{
  if(err && !err.message.includes("duplicate column")){
    console.log(err);
  }
});
db.run(`
  ALTER TABLE tournaments
  ADD COLUMN type TEXT DEFAULT 'poule'
`,()=>{});
db.run(`
  ALTER TABLE matches
  ADD COLUMN leg TEXT DEFAULT ''
`,()=>{});
db.run(`
  CREATE TABLE IF NOT EXISTS rapid_qualifiers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER,
    round TEXT,
    player_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`
  DELETE FROM rapid_qualifiers
  WHERE id NOT IN (
    SELECT MIN(id)
    FROM rapid_qualifiers
    GROUP BY tournament_id, round, player_id
  )
`, err => {

  if(err){
    console.log(
      "Erreur nettoyage rapid_qualifiers :",
      err
    );
    return;
  }

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    idx_rapid_qualifier_unique
    ON rapid_qualifiers(
      tournament_id,
      round,
      player_id
    )
  `);

});

db.run(`
  CREATE TABLE IF NOT EXISTS highlight_likes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    highlight_id INTEGER,
    user_id INTEGER,
    UNIQUE(highlight_id,user_id)
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS user_player_stats(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    season_year INTEGER,
    matchs INTEGER DEFAULT 0,
    victoires INTEGER DEFAULT 0,
    nuls INTEGER DEFAULT 0,
    defaites INTEGER DEFAULT 0,
    buts_marques INTEGER DEFAULT 0,
    buts_encaisses INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0,
    niveau INTEGER DEFAULT 1,
    coupes INTEGER DEFAULT 0,
    tournois_participes INTEGER DEFAULT 0,
    tournois_gagnes INTEGER DEFAULT 0,
    UNIQUE(user_id, season_year)
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS user_trophies(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    tournament_id INTEGER,
    tournament_name TEXT,
    trophy TEXT,
    won_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`
  ALTER TABLE user_player_stats
  ADD COLUMN tournois_participes INTEGER DEFAULT 0
`,()=>{});

db.run(`
  ALTER TABLE user_player_stats
  ADD COLUMN tournois_gagnes INTEGER DEFAULT 0
`,()=>{});
db.run(`
CREATE TABLE IF NOT EXISTS counted_tournaments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER UNIQUE,
  counted_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_trophy_unique
  ON user_trophies(user_id, tournament_id, trophy)
`);
db.run(`
  ALTER TABLE highlight_comments
  ADD COLUMN user_id INTEGER
`, err=>{
  if(err && !err.message.includes("duplicate column")){
    console.log(err);
  }
});
db.run(`
  CREATE TABLE IF NOT EXISTS video_favorites(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    highlight_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, highlight_id)
  )
`);
db.run(`
CREATE TABLE IF NOT EXISTS fcm_tokens(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  token TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS rewards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  reward TEXT,
  sender_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS warnings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  admin_id INTEGER,
  reason TEXT,
  video_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS video_watch_time(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  highlight_id INTEGER,
  seconds INTEGER DEFAULT 0,
  percent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS highlight_views(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  highlight_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, highlight_id)
)
`);
db.run(
  `
  DELETE FROM notifications
  WHERE datetime(created_at)
        < datetime('now','-30 days')
  `,
  error =>{

    if(error){

      console.error(
        "Erreur nettoyage notifications :",
        error
      );

    }

  }
);

db.run(`
  ALTER TABLE rapid_qualifiers
  ADD COLUMN source_order INTEGER
`,()=>{});


app.get("/", async (req,res)=>{

  try{

    const highlights = await all(
      `
     SELECT
     h.*,
     u.username,
     u.name,
     u.profile_photo
     FROM highlights h
     LEFT JOIN users u
     ON u.id=h.user_id
     ORDER BY h.likes DESC, h.vues DESC, h.id DESC
     LIMIT 6 
      `
    );

    const cards = highlights.map(h=>`
      <div class="card">
        <h3>🔥 ${escapeHtml(h.titre)}</h3>
        <p>
         <b>${escapeHtml(h.username || h.name || "Joueur")}</b>
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

app.post(
  "/send-code",
  emailCodeLimiter,
  async (req,res)=>{

  try{

    const { email } = req.body;

    if(!email){
      return res.send(
    tr(
    req,
    "Email obligatoire",
    "Email is required"
    )
  );
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
      return res.send(
     tr(
    req,
    "Email déjà utilisé",
    "Email already used"
    )
  );
    }

    await run(
  `
  DELETE FROM email_codes
  WHERE email=?
     OR datetime(created_at)
        < datetime('now','-1 day')
  `,
  [cleanEmail]
);

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

    res.send(
  tr(
    req,
    "Code envoyé",
    "Verification code sent"
  )
);

  }catch(e){

    console.log(e);
    res.send(
  tr(
    req,
    "Erreur envoi code",
    "Failed to send code"
  )
);

  }

});
const bannedWords = [
  "porn",
  "sexe",
  "pute",
  "escort",
  "terror",
  "hack",
  "casino",
  "bet",
  "pari",
  "drogue"
];
function containsBadWords(text=""){

  const lower =
    text.toLowerCase();

  return bannedWords.some(
    w => lower.includes(w)
  );

}

app.post("/register", async (req,res)=>{

  try{

    const { name,email,password,code } = req.body;

    if(!name || !email || !password || !code){
      return res.send(
  tr(
    req,
    "Tous les champs sont obligatoires",
    "All fields are required"
  )
);
    }

    if(password.length < 8){
      return res.send(
  tr(
    req,
    "Mot de passe minimum 8 caractères",
    "Password must contain at least 8 characters"
  )
);
    }

    if(
      containsBadWords(name) ||
      containsBadWords(email)
    ){
      return res.send(
  tr(
    req,
    "Contenu interdit détecté",
    "Forbidden content detected"
  )
);
    }

    const cleanEmail =
      email.trim().toLowerCase();

    const verification = await get(
  `
  SELECT id
  FROM email_codes
  WHERE email=?
    AND code=?
    AND datetime(created_at)
        >= datetime('now','-15 minutes')
  ORDER BY id DESC
  LIMIT 1
  `,
  [
    cleanEmail,
    String(code).trim()
  ]
);

    if(!verification){
      return res.send(
  tr(
    req,
    "Code expiré",
    "expired verification code"
  )
);
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
      async function(err){

        if(err){
          return res.send(
  tr(
    req,
    "Email déjà utilisé",
    "Email already used"
  )
);
        }

        const userId = this.lastID;

        const autoUsername =
          "user" + userId;

        await run(
          `
          UPDATE users
          SET username=?
          WHERE id=?
          `,
          [
            autoUsername,
            userId
          ]
        );

        await run(
          `
          DELETE FROM email_codes
          WHERE email=?
          `,
          [cleanEmail]
        );

        req.session.userId = userId;

        res.send(
  tr(
    req,
    "Compte créé",
    "Account created"
  )
);

      }
    );

  }catch(e){

    console.log(e);
    res.send(
  tr(
    req,
    "Erreur inscription",
    "Registration failed"
  )
);

  }

});
app.post("/login", loginLimiter, (req,res)=>{

  const { email,password } = req.body;

  if(!email || !password){
    return res.send(
  tr(
    req,
    "Email et mot de passe obligatoires",
    "Email and password are required"
  )
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
        return res.send(
      tr(
      req,
      "Compte introuvable",
    "Account not found"
  )
);
      }

      if(Number(user.banned) === 1){
        return res.send(
  tr(
    req,
    "Compte banni. Contacte l’admin.",
    "Account banned. Contact the admin."
  )
);
      }

      const ok =
        await bcrypt.compare(
          password,
          user.password
        );

      if(!ok){
        return res.send(
  tr(
    req,
    "Mot de passe incorrect",
    "Incorrect password"
  )
);
      }

      req.session.regenerate(err=>{

        if(err){
          return res.send(
  tr(
    req,
    "Erreur session",
    "Session error"
  )
);
        }

        req.session.userId = user.id;

        res.send(
  tr(
    req,
    "Connexion réussie",
    "Login successful"
  )
);

      });

    }
  );

});

const uploadLimiter = rateLimit({

  windowMs: 15 * 60 * 1000,

  max: 20,

  standardHeaders: true,

  legacyHeaders: false,

  message:{
    ok:false,
    message:
      "Trop d'envois de fichiers. Réessaie plus tard."
  }

});

app.post("/logout",(req,res)=>{

  req.session.destroy(()=>{
    res.send(
  tr(
    req,
    "Déconnecté",
    "Logged out"
  )
);
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
      username,
      username_updated_at,
      abonnement,
      abonnement_expire_at,
      profile_photo
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

  res.json({
    connected:true,
    ...user
  });

});

app.post("/abonnement", async (req,res)=>{

  if(!connected(req)){

    return res.status(401).send(
      tr(
        req,
        "Connecte-toi",
        "Please log in"
      )
    );

  }

  return res.status(403).send(
    tr(
      req,
      "L'abonnement doit être validé après vérification du paiement",
      "The subscription must be approved after payment verification"
    )
  );

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
      return res.send(
  tr(req,"Connecte-toi d'abord","Please log in first")
);
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
      return res.send(
  tr(req,"Utilisateur introuvable","User not found")
);
    }

    const {
      name,
      max_teams,
      group_link,
      type
    } = req.body;

    const cleanName =
  String(name || "")
    .trim();

if(!cleanName){

  return res.status(400).send(
    tr(
      req,
      "Nom tournoi obligatoire",
      "Tournament name is required"
    )
  );

}

if(
  cleanName.length < 3 ||
  cleanName.length > 60
){

  return res.status(400).send(
    tr(
      req,
      "Le nom du tournoi doit contenir entre 3 et 60 caractères",
      "The tournament name must contain between 3 and 60 characters"
    )
  );

}

    const maxTeams =
  Number(max_teams);

if(
  !Number.isInteger(maxTeams) ||
  maxTeams < 6 ||
  maxTeams > 100
){

  return res.status(400).send(
    tr(
      req,
      "Le nombre d'équipes doit être un nombre entier entre 6 et 100",
      "The number of teams must be an integer between 6 and 100"
    )
  );

}

const tournamentType =
  String(type || "poule")
    .trim()
    .toLowerCase();

if(
  tournamentType !== "poule" &&
  tournamentType !== "rapide"
){

  return res.status(400).send(
    tr(
      req,
      "Type de tournoi invalide",
      "Invalid tournament type"
    )
  );

}

if(
  tournamentType === "rapide" &&
  maxTeams !== 32
){

  return res.status(400).send(
    tr(
      req,
      "Le tournoi rapide exige exactement 32 équipes",
      "The quick tournament requires exactly 32 teams"
    )
  );

}

    if(
      maxTeams > 33 &&
      user.abonnement !== 1
    ){
      return res.send(
        tr(
          req,
          "Abonnement requis pour créer un tournoi de plus de 33 équipes",
          "Subscription required to create a tournament with more than 33 teams"
        )
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

    const dejaOuvert = await get(
  `
  SELECT id
  FROM tournaments
  WHERE user_id=?
    AND status='open'
    AND name=?
  LIMIT 1
  `,
  [
    req.session.userId,
    cleanName
  ]
);

if(dejaOuvert){

  return res.status(409).send(
    tr(
      req,
      "Un tournoi portant ce nom est déjà ouvert",
      "A tournament with this name is already open"
    )
  );

}

    const joinCode =
      Math.random()
      .toString(36)
      .substring(2,10);

    await run(
      `
      INSERT INTO tournaments(
        user_id,
        name,
        max_teams,
        status,
        join_code,
        group_link,
        type
      )
      VALUES(?,?,?,?,?,?,?)
      `,
      [
        req.session.userId,
        cleanName,
        maxTeams,
        "open",
        joinCode,
        group_link || "",
        tournamentType
      ]
    );

    res.send(
  tr(req,"Tournoi créé","Tournament created")
);

  }catch(e){

    console.log(e);
    
res.send(
  tr(req,"Erreur création tournoi","Tournament creation failed")
);
  }

});

app.get("/tournois", async (req,res)=>{

  if(!connected(req)){
    return res.json([]);
  }

  try{

    const rows = await all(
      `
      SELECT
        t.*,
        pchamp.prenom AS champion_name
      FROM tournaments t
      LEFT JOIN participants pchamp
      ON pchamp.id = t.champion_id
      WHERE t.user_id=?
      ORDER BY t.id DESC
      `,
      [req.session.userId]
    );

    res.json(rows);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.post("/participant", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send(
  tr(req,"Connecte-toi","Please log in")
);
    }

    const {
      tournament_id,
      participantUsername,
      telephone,
      club_logo
    } = req.body;

    if(!tournament_id || !participantUsername){
      return res.send(
  tr(req,"Tournoi et nom utilisateur obligatoires","Tournament and username are required")
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
      return res.send(
  tr(req,"Tournoi introuvable","Tournament not found")
);
    }

    if(
  tournoi.status === "started" ||
  tournoi.status === "finished"
){

  return res.status(409).send(
    tr(
      req,
      "Impossible d'ajouter un participant : le tournoi a déjà commencé",
      "A participant cannot be added because the tournament has already started"
    )
  );

}
    const ownerCheck =
  await verifierProprietaireTournoi(req, tournament_id);

if(!ownerCheck.ok){
  return res.send(ownerCheck.message);
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

  return res.status(409).send(
    tr(
      req,
      `Maximum de ${tournoi.max_teams} équipes atteint`,
      `Maximum of ${tournoi.max_teams} teams reached`
    )
  );

}

    const cleanUsername =
  String(participantUsername || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();

    if(!cleanUsername){

  return res.status(400).send(
    tr(
      req,
      "Nom utilisateur invalide",
      "Invalid username"
    )
  );

}

    const user = await get(
      `
      SELECT *
      FROM users
      WHERE username=?
      `,
      [cleanUsername]
    );

    if(!user){
      return res.send(
  tr(req,"Compte SNUGAME introuvable","SNUGAME account not found")
  );
      
    }

    const already = await get(
      `
      SELECT id
      FROM participants
      WHERE tournament_id=?
      AND user_id=?
      `,
      [
        tournament_id,
        user.id
      ]
    );

    if(already){
      return res.send(
  tr(req,"Ce joueur est déjà dans ce tournoi","This player is already in this tournament")
);
    }

    const prenom =
      user.name || user.username;

    const result = await run(
      `
      INSERT INTO participants(
        tournament_id,
        prenom,
        user_id,
        username,
        telephone,
        club_logo
      )
      VALUES(?,?,?,?,?,?)
      `,
      [
        tournament_id,
        prenom,
        user.id,
        user.username || "",
        telephone || "",
        club_logo || ""
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

    await notifierUtilisateur(
  user.id,
  "📢 Invitation tournoi",
  "Tu as été ajouté au tournoi : " + (tournoi.name || ""),
  "tournament:" + tournament_id
);

    res.send(
  tr(req,"Participant ajouté","Participant added")
);

  }catch(e){

    console.log(e);
    res.send(
  tr(req,"Erreur ajout participant : ","Failed to add participant: ") + e.message
);

  }

});

app.get("/participants/:id", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).json({
        ok:false,
        message:tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      });

    }

    const tournamentId =
      Number(req.params.id);

    if(
      !Number.isInteger(tournamentId) ||
      tournamentId <= 0
    ){

      return res.status(400).json({
        ok:false,
        message:tr(
          req,
          "Identifiant du tournoi invalide",
          "Invalid tournament ID"
        )
      });

    }

    const tournoi = await get(
      `
      SELECT id
      FROM tournaments
      WHERE id=?
      `,
      [tournamentId]
    );

    if(!tournoi){

      return res.status(404).json({
        ok:false,
        message:tr(
          req,
          "Tournoi introuvable",
          "Tournament not found"
        )
      });

    }

    const rows = await all(
      `
      SELECT
        p.id,
        p.tournament_id,
        p.prenom,
        p.username,
        p.club_logo,
        p.group_name,
        p.user_id,
        u.profile_photo
      FROM participants p
      LEFT JOIN users u
        ON u.id=p.user_id
      WHERE p.tournament_id=?
      ORDER BY p.id
      `,
      [tournamentId]
    );

    return res.json(rows);

  }catch(error){

    console.error(
      "Erreur chargement participants :",
      error
    );

    return res.status(500).json({
      ok:false,
      message:tr(
        req,
        "Impossible de charger les participants",
        "Failed to load participants"
      )
    });

  }

});

app.post(
  "/supprimer-participants-selection",
  async (req,res)=>{

    try{

      if(!connected(req)){
        return res.status(401).send(
          tr(
            req,
            "Connecte-toi",
            "Please log in"
          )
        );
      }

      const { ids } = req.body;

      if(
        !Array.isArray(ids) ||
        ids.length === 0
      ){
        return res.status(400).send(
          tr(
            req,
            "Aucun participant sélectionné",
            "No participant selected"
          )
        );
      }

      const cleanIds =
        ids
          .map(Number)
          .filter(
            id =>
              Number.isInteger(id) &&
              id > 0
          );

      if(cleanIds.length !== ids.length){
        return res.status(400).send(
          tr(
            req,
            "Liste de participants invalide",
            "Invalid participant list"
          )
        );
      }

      const participant = await get(
        `
        SELECT tournament_id
        FROM participants
        WHERE id=?
        `,
        [cleanIds[0]]
      );

      if(!participant){
        return res.status(404).send(
          tr(
            req,
            "Participant introuvable",
            "Participant not found"
          )
        );
      }

      const ownerCheck =
        await verifierProprietaireTournoi(
          req,
          participant.tournament_id
        );

      if(!ownerCheck.ok){
        return res.status(403).send(
          ownerCheck.message
        );
      }

      const tournoi =
  ownerCheck.tournoi;

if(
  tournoi.status === "started" ||
  tournoi.status === "finished"
){

  return res.status(409).send(
    tr(
      req,
      "Impossible de supprimer des participants : le tournoi a déjà commencé",
      "Participants cannot be deleted because the tournament has already started"
    )
  );

}

      const placeholders =
        cleanIds.map(() => "?").join(",");

      const participantsSelectionnes =
        await all(
          `
          SELECT id, tournament_id
          FROM participants
          WHERE id IN (${placeholders})
          `,
          cleanIds
        );

      if(
        participantsSelectionnes.length !==
        cleanIds.length
      ){
        return res.status(404).send(
          tr(
            req,
            "Un ou plusieurs participants sont introuvables",
            "One or more participants were not found"
          )
        );
      }

      const tournoiDifferent =
        participantsSelectionnes.some(
          p =>
            Number(p.tournament_id) !==
            Number(participant.tournament_id)
        );

      if(tournoiDifferent){
        return res.status(403).send(
          tr(
            req,
            "Impossible de supprimer des participants de plusieurs tournois",
            "Participants from different tournaments cannot be deleted together"
          )
        );
      }

      await run(
  `
  DELETE FROM player_stats
  WHERE participant_id IN (${placeholders})
  `,
  cleanIds
);

      await run(
        `
        DELETE FROM participants
        WHERE id IN (${placeholders})
        `,
        cleanIds
      );

      return res.send(
        tr(
          req,
          "Participants supprimés",
          "Participants deleted"
        )
      );

    }catch(error){

      console.error(
        "Erreur suppression participants :",
        error
      );

      return res.status(500).send(
        tr(
          req,
          "Erreur suppression",
          "Deletion failed"
        )
      );

    }

  }
);


app.post(
  "/supprimer-tournoi-complet",
  async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const tournamentId =
      Number(req.body.tournament_id);

    if(
      !Number.isInteger(tournamentId) ||
      tournamentId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Tournoi manquant ou invalide",
          "Tournament is missing or invalid"
        )
      );

    }

    const ownerCheck =
      await verifierProprietaireTournoi(
        req,
        tournamentId
      );

    if(!ownerCheck.ok){

      return res.status(403).send(
        ownerCheck.message
      );

    }

    await run("BEGIN TRANSACTION");

    try{

      await run(
        `
        DELETE FROM matches
        WHERE tournament_id=?
        `,
        [tournamentId]
      );

      await run(
        `
        DELETE FROM rapid_qualifiers
        WHERE tournament_id=?
        `,
        [tournamentId]
      );

      await run(
        `
        DELETE FROM player_stats
        WHERE participant_id IN (
          SELECT id
          FROM participants
          WHERE tournament_id=?
        )
        `,
        [tournamentId]
      );

      await run(
        `
        DELETE FROM participants
        WHERE tournament_id=?
        `,
        [tournamentId]
      );

      await run(
        `
        DELETE FROM counted_tournaments
        WHERE tournament_id=?
        `,
        [tournamentId]
      );

      await run(
        `
        DELETE FROM user_trophies
        WHERE tournament_id=?
        `,
        [tournamentId]
      );

      await run(
        `
        DELETE FROM tournaments
        WHERE id=?
        `,
        [tournamentId]
      );

      await run("COMMIT");

      return res.send(
        tr(
          req,
          "Tournoi supprimé",
          "Tournament deleted"
        )
      );

    }catch(errorTransaction){

      try{
        await run("ROLLBACK");
      }catch(errorRollback){

        console.error(
          "Erreur ROLLBACK suppression tournoi :",
          errorRollback
        );

      }

      throw errorTransaction;

    }

  }catch(error){

    console.error(
      "Erreur suppression tournoi :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur suppression tournoi",
        "Tournament deletion failed"
      )
    );

  }

});


app.post("/reset-tournoi", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const tournamentId =
      Number(req.body.tournament_id);

    if(
      !Number.isInteger(tournamentId) ||
      tournamentId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Tournoi obligatoire ou invalide",
          "Tournament is required or invalid"
        )
      );

    }

    const ownerCheck =
      await verifierProprietaireTournoi(
        req,
        tournamentId
      );

    if(!ownerCheck.ok){

      return res.status(403).send(
        ownerCheck.message
      );

    }

    await run("BEGIN TRANSACTION");

    try{

      await run(
        `
        DELETE FROM matches
        WHERE tournament_id=?
        `,
        [tournamentId]
      );

      await run(
        `
        DELETE FROM rapid_qualifiers
        WHERE tournament_id=?
        `,
        [tournamentId]
      );

      await run(
        `
        UPDATE participants
        SET group_name=NULL
        WHERE tournament_id=?
        `,
        [tournamentId]
      );

      await run(
        `
        UPDATE tournaments
        SET status='open',
            champion_id=NULL
        WHERE id=?
        `,
        [tournamentId]
      );

      await run("COMMIT");

      return res.send(
        tr(
          req,
          "Tournoi réinitialisé",
          "Tournament reset"
        )
      );

    }catch(errorTransaction){

      try{
        await run("ROLLBACK");
      }catch(errorRollback){

        console.error(
          "Erreur ROLLBACK reset tournoi :",
          errorRollback
        );

      }

      throw errorTransaction;

    }

  }catch(error){

    console.error(
      "Erreur reset tournoi :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur réinitialisation du tournoi",
        "Tournament reset failed"
      )
    );

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
    AND played=1
    `,
    [tournament_id]
  );

  const table = {};

  for(const t of teams){

    table[t.id] = {
      id:t.id,
      prenom:t.prenom,
      group_name:t.group_name || "Sans groupe",
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

    const a = table[m.player1_id];
    const b = table[m.player2_id];

    if(!a || !b) continue;

   if(
  m.score1 === null ||
  m.score1 === undefined ||
  m.score2 === null ||
  m.score2 === undefined
){
  continue;
}

const s1 =
  Number(m.score1);

const s2 =
  Number(m.score2);

if(
  !Number.isInteger(s1) ||
  !Number.isInteger(s2) ||
  s1 < 0 ||
  s2 < 0
){
  continue;
}

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

    if(!groups[t.group_name]){
      groups[t.group_name] = [];
    }

    groups[t.group_name].push(t);

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
async function assurerStatsJoueur(user_id){

  const currentYear =
    new Date().getFullYear();

  await run(
    `
    INSERT OR IGNORE INTO user_player_stats(
      user_id,
      season_year
    )
    VALUES(?,?)
    `,
    [
      user_id,
      currentYear
    ]
  );

}
async function mettreAJourStatsMatch(user_id, butsPour, butsContre, resultat){

  const currentYear =
    new Date().getFullYear();

  await assurerStatsJoueur(user_id);

  let xpChange = 5;

  if(resultat === "victoire"){
    xpChange = 15;
  }
  else if(resultat === "nul"){
    xpChange = 7;
  }
  else if(resultat === "defaite"){
    xpChange = -3;
  }

  await run(
    `
    UPDATE user_player_stats
    SET matchs = matchs + 1,
        victoires = victoires + CASE WHEN ?='victoire' THEN 1 ELSE 0 END,
        nuls = nuls + CASE WHEN ?='nul' THEN 1 ELSE 0 END,
        defaites = defaites + CASE WHEN ?='defaite' THEN 1 ELSE 0 END,
        buts_marques = buts_marques + ?,
        buts_encaisses = buts_encaisses + ?,
        xp = MAX(xp + ?, 0),
        niveau = MAX(1, CAST((MAX(xp + ?, 0) / 100) AS INTEGER) + 1)
    WHERE user_id=?
    AND season_year=?
    `,
    [
      resultat,
      resultat,
      resultat,
      butsPour,
      butsContre,
      xpChange,
      xpChange,
      user_id,
      currentYear
    ]
  );

}
async function compterTournoiTermine(tournament_id){

  const dejaCompte = await get(
    `
    SELECT id
    FROM counted_tournaments
    WHERE tournament_id=?
    `,
    [tournament_id]
  );

  if(dejaCompte){
    return;
  }

  const officiel =
    await tournoiOfficiel(tournament_id);

  if(!officiel){
    return;
  }

  const participants = await all(
    `
    SELECT DISTINCT user_id
    FROM participants
    WHERE tournament_id=?
    AND user_id IS NOT NULL
    `,
    [tournament_id]
  );

  for(const p of participants){

    await assurerStatsJoueur(p.user_id);

    await run(
      `
      UPDATE user_player_stats
      SET tournois_participes = tournois_participes + 1
      WHERE user_id=?
      AND season_year=?
      `,
      [
        p.user_id,
        new Date().getFullYear()
      ]
    );

  }

  await run(
    `
    INSERT INTO counted_tournaments(tournament_id)
    VALUES(?)
    `,
    [tournament_id]
  );

}
async function recompenserChampion(tournament_id, champion_participant_id){

  const officiel =
    await tournoiOfficiel(tournament_id);

  if(!officiel){
    return;
  }

  const champion = await get(
    `
    SELECT user_id
    FROM participants
    WHERE id=?
    `,
    [champion_participant_id]
  );

  if(!champion || !champion.user_id){
    return;
  }

  const tournoi = await get(
    `
    SELECT name
    FROM tournaments
    WHERE id=?
    `,
    [tournament_id]
  );

  await assurerStatsJoueur(champion.user_id);

  const trophéeAjoute =
  await run(
    `
    INSERT OR IGNORE INTO user_trophies(
      user_id,
      tournament_id,
      tournament_name,
      trophy
    )
    VALUES(?,?,?,?)
    `,
    [
      champion.user_id,
      tournament_id,
      tournoi
        ? tournoi.name
        : "Tournoi",
      "🏆 Champion"
    ]
  );

if(
  Number(trophéeAjoute.changes || 0) === 0
){

  /*
    Le trophée existait déjà :
    on ne recompte pas les statistiques.
  */
  return;

}

await run(
  `
  UPDATE user_player_stats
  SET tournois_gagnes =
        tournois_gagnes + 1,
      coupes =
        coupes + 1,
      xp =
        xp + 100,
      niveau =
        CAST(
          (xp + 100) / 100
          AS INTEGER
        ) + 1
  WHERE user_id=?
    AND season_year=?
  `,
  [
    champion.user_id,
    new Date().getFullYear()
  ]
);

}
async function tournoiOfficiel(tournament_id){

  const count = await get(
    `
    SELECT COUNT(*) AS total
    FROM participants
    WHERE tournament_id=?
    `,
    [tournament_id]
  );

  return Number(count.total || 0) >= 15;

}

async function enregistrerChampionApresFinale(
  match
){

  if(
    match.round !== "FINALE"
  ){
    return;
  }

  const finale = await all(
    `
    SELECT *
    FROM matches
    WHERE tournament_id=?
      AND round='FINALE'
    ORDER BY match_order ASC, id ASC
    `,
    [match.tournament_id]
  );

  const aller =
    finale.find(
      m =>
        m.journee === "ALLER" ||
        m.leg === "ALLER"
    );

  const retour =
    finale.find(
      m =>
        m.journee === "RETOUR" ||
        m.leg === "RETOUR"
    );

  if(
    !aller ||
    !retour ||
    Number(aller.played) !== 1 ||
    Number(retour.played) !== 1
  ){
    return;
  }

  const player1 =
    Number(aller.player1_id);

  const player2 =
    Number(aller.player2_id);

  function scoreDuJoueur(
    matchRow,
    playerId
  ){

    if(
      Number(matchRow.player1_id) ===
      playerId
    ){

      return Number(
        matchRow.score1 || 0
      );

    }

    if(
      Number(matchRow.player2_id) ===
      playerId
    ){

      return Number(
        matchRow.score2 || 0
      );

    }

    return 0;

  }

  const total1 =
    scoreDuJoueur(
      aller,
      player1
    ) +
    scoreDuJoueur(
      retour,
      player1
    );

  const total2 =
    scoreDuJoueur(
      aller,
      player2
    ) +
    scoreDuJoueur(
      retour,
      player2
    );

  let championId = null;

  if(total1 > total2){

    championId = player1;

  }else if(total2 > total1){

    championId = player2;

  }else{

    const penalty1 =
      retour.penalty1 === null ||
      retour.penalty1 === undefined
        ? null
        : Number(retour.penalty1);

    const penalty2 =
      retour.penalty2 === null ||
      retour.penalty2 === undefined
        ? null
        : Number(retour.penalty2);

    if(
      penalty1 === null ||
      penalty2 === null ||
      penalty1 === penalty2
    ){
      return;
    }

    championId =
      penalty1 > penalty2
        ? Number(retour.player1_id)
        : Number(retour.player2_id);

  }

  const tournoi = await get(
    `
    SELECT
      id,
      name,
      status,
      champion_id
    FROM tournaments
    WHERE id=?
    `,
    [match.tournament_id]
  );

  if(!tournoi){
    return;
  }

  /*
    Évite d'enregistrer et récompenser
    deux fois le même champion.
  */
  if(
    tournoi.status === "finished" &&
    Number(tournoi.champion_id) ===
    Number(championId)
  ){
    return;
  }

  await run(
    `
    UPDATE tournaments
    SET champion_id=?,
        status='finished'
    WHERE id=?
    `,
    [
      championId,
      match.tournament_id
    ]
  );

  await compterTournoiTermine(
    match.tournament_id
  );

  await recompenserChampion(
    match.tournament_id,
    championId
  );

  const champion = await get(
    `
    SELECT
      user_id,
      prenom
    FROM participants
    WHERE id=?
    `,
    [championId]
  );

  if(
    champion &&
    champion.user_id
  ){

    await notifierUtilisateur(
      champion.user_id,
      "👑 Champion SNUGAME",
      `Félicitations ! Tu as remporté le tournoi "${tournoi.name || "Tournoi"}" 🏆`,
      `tournament:${match.tournament_id}`
    );

  }

}

app.post("/update-match-proof", async (req,res)=>{

  try{

    if(!connected(req)){

  return res.status(401).send(
    tr(
      req,
      "Connecte-toi pour valider un score",
      "Log in to validate a score"
    )
  );

}

    const {
  score1,
  score2,
  penalty1,
  penalty2,
  photo_url
} = req.body;

const matchId =
  Number(req.body.match_id);

if(
  !Number.isInteger(matchId) ||
  matchId <= 0
){

  return res.status(400).send(
    tr(
      req,
      "Match obligatoire ou invalide",
      "Match is required or invalid"
    )
  );

}

    const match = await get(
      `
      SELECT *
      FROM matches
      WHERE id=?
      `,
      [matchId]
    );

    if(!match){
      return res.send(
  tr(req,"Match introuvable","Match not found")
);
    }

    const tournoi = await get(
  `
  SELECT *
  FROM tournaments
  WHERE id=?
  `,
  [match.tournament_id]
);

if(
  !tournoi ||
  Number(tournoi.user_id) !== Number(req.session.userId)
){
  return res.send(
    tr(req,
      "Accès refusé : seul le propriétaire du tournoi peut valider le score",
      "Access denied: only the tournament owner can validate the score"
    )
  );
}

    if(Number(match.locked) === 1){
      return res.send(
        tr(req,
          "Score verrouillé",
          "Score is locked"
        )
      );
    }

    if(Number(match.played) === 1){
     return res.send(
       tr(req,
         "Ce match est déjà validé",
         "This match is already validated"
       )
     );
   }

    const s1 = Number(score1);
    const s2 = Number(score2);

    const p1 =
  penalty1 === null ||
  penalty1 === undefined ||
  penalty1 === ""
    ? null
    : Number(penalty1);

const p2 =
  penalty2 === null ||
  penalty2 === undefined ||
  penalty2 === ""
    ? null
    : Number(penalty2);

    if(
  !Number.isInteger(s1) ||
  !Number.isInteger(s2)
){

  return res.status(400).send(
    tr(
      req,
      "Les scores doivent être des nombres entiers",
      "Scores must be whole numbers"
    )
  );

}

if(
  s1 < 0 ||
  s2 < 0 ||
  s1 > 100 ||
  s2 > 100
){

  return res.status(400).send(
    tr(
      req,
      "Les scores doivent être compris entre 0 et 100",
      "Scores must be between 0 and 100"
    )
  );

}

if(
  p1 !== null ||
  p2 !== null
){

  if(
    p1 === null ||
    p2 === null
  ){

    return res.status(400).send(
      tr(
        req,
        "Les deux scores des tirs au but sont obligatoires",
        "Both penalty shootout scores are required"
      )
    );

  }

  if(
    !Number.isInteger(p1) ||
    !Number.isInteger(p2) ||
    p1 < 0 ||
    p2 < 0 ||
    p1 > 100 ||
    p2 > 100
  ){

    return res.status(400).send(
      tr(
        req,
        "Les tirs au but doivent être des nombres entiers entre 0 et 100",
        "Penalty shootout scores must be whole numbers between 0 and 100"
      )
    );

  }

  if(p1 === p2){

    return res.status(400).send(
      tr(
        req,
        "Les tirs au but ne peuvent pas être égaux",
        "Penalty shootout scores cannot be equal"
      )
    );

  }

  const matchRetour =
    match.journee === "RETOUR" ||
    match.leg === "RETOUR";

  if(
    match.round === "POULE" ||
    !matchRetour
  ){

    return res.status(400).send(
      tr(
        req,
        "Les tirs au but sont autorisés uniquement au match retour d'une phase éliminatoire",
        "Penalty shootouts are allowed only in the second leg of a knockout round"
      )
    );

  }

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

    const validationMatch =
  await run(
    `
    UPDATE matches
    SET score1=?,
        score2=?,
        penalty1=?,
        penalty2=?,
        proof_photo=?,
        winner_id=?,
        loser_id=?,
        played=1
    WHERE id=?
      AND played=0
      AND locked=0
    `,
    [
      s1,
      s2,
      p1,
      p2,
      photo_url || "",
      winner,
      loser,
      matchId
    ]
  );

if(
  Number(validationMatch.changes || 0) === 0
){

  return res.status(409).send(
    tr(
      req,
      "Ce match est déjà validé ou verrouillé",
      "This match has already been validated or locked"
    )
  );

}

    const matchPlayers = await all(
  `
  SELECT
    id,
    user_id,
    prenom
  FROM participants
  WHERE id IN (?,?)
  `,
  [
    match.player1_id,
    match.player2_id
  ]
);

const tournoiScore = await get(
  `
  SELECT name
  FROM tournaments
  WHERE id=?
  `,
  [match.tournament_id]
);

for(const p of matchPlayers){

  if(!p.user_id){
    continue;
  }

  await notifierUtilisateur(
    p.user_id,
    "⚽ Résultat validé",
    `Score validé : ${s1} - ${s2} dans ${tournoiScore?.name || "le tournoi"}`,
    `tournament:${match.tournament_id}`
  );

}

    const officiel =
  await tournoiOfficiel(match.tournament_id);

if(officiel){

  const joueur1 = await get(
    `
    SELECT user_id
    FROM participants
    WHERE id=?
    `,
    [match.player1_id]
  );

  const joueur2 = await get(
    `
    SELECT user_id
    FROM participants
    WHERE id=?
    `,
    [match.player2_id]
  );

  if(joueur1 && joueur1.user_id){
    await mettreAJourStatsMatch(
      joueur1.user_id,
      s1,
      s2,
      s1 > s2 ? "victoire" : s1 === s2 ? "nul" : "defaite"
    );
  }

  if(joueur2 && joueur2.user_id){
    await mettreAJourStatsMatch(
      joueur2.user_id,
      s2,
      s1,
      s2 > s1 ? "victoire" : s1 === s2 ? "nul" : "defaite"
    );
  }

}
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
    if(winner){

  await run(
    `
    UPDATE users
    SET world_points = world_points + 3,
        world_wins = world_wins + 1
    WHERE email = (
      SELECT email
      FROM participants
      WHERE id=?
    )
    `,
    [winner]
  );

}

if(loser){

  await run(
    `
    UPDATE users
    SET world_losses = world_losses + 1
    WHERE email = (
      SELECT email
      FROM participants
      WHERE id=?
    )
    `,
    [loser]
  );

}

await run(
  `
  UPDATE users
  SET world_goals = world_goals + ?
  WHERE email = (
    SELECT email
    FROM participants
    WHERE id=?
  )
  `,
  [s1, match.player1_id]
);

await run(
  `
  UPDATE users
  SET world_goals = world_goals + ?
  WHERE email = (
    SELECT email
    FROM participants
    WHERE id=?
  )
  `,
  [s2, match.player2_id]
);


  await enregistrerChampionApresFinale(
  match
);

return res.send(
  tr(
    req,
    "Score validé",
    "Score validated"
  )
);

}catch(e){

  console.log(e);
  res.send(
    tr(req,"Erreur validation score : " + e.message,"Error validating score : " + e.message)
  );

}

});

app.post("/annuler-score", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const matchId =
  Number(req.body.match_id);

if(
  !Number.isInteger(matchId) ||
  matchId <= 0
){

  return res.status(400).send(
    tr(
      req,
      "Match obligatoire ou invalide",
      "Match is required or invalid"
    )
  );

}

    const match = await get(
      `
      SELECT *
      FROM matches
      WHERE id=?
      `,
      [matchId]
    );

    if(!match){

      return res.status(404).send(
        tr(
          req,
          "Match introuvable",
          "Match not found"
        )
      );

    }

    const ownerCheck =
      await verifierProprietaireTournoi(
        req,
        match.tournament_id
      );

    if(!ownerCheck.ok){

      return res.status(403).send(
        ownerCheck.message
      );

    }

    const officiel =
  await tournoiOfficiel(
    match.tournament_id
  );

if(officiel){

  return res.status(409).send(
    tr(
      req,
      "Impossible d'annuler ce score : les statistiques officielles ont déjà été enregistrées",
      "This score cannot be cancelled because official statistics have already been recorded"
    )
  );

}

    if(Number(match.locked) === 1){

      return res.status(409).send(
        tr(
          req,
          "Score verrouillé impossible à annuler",
          "Score is locked and cannot be cancelled"
        )
      );

    }

    if(match.round !== "POULE"){

  const nextRound =
    getNextRoundRapide(
      match.round
    );

  if(nextRound){

    const tourSuivant = await get(
      `
      SELECT COUNT(*) AS total
      FROM matches
      WHERE tournament_id=?
        AND round=?
      `,
      [
        match.tournament_id,
        nextRound
      ]
    );

    if(
      Number(
        tourSuivant?.total || 0
      ) > 0
    ){

      return res.status(409).send(
        tr(
          req,
          "Impossible d'annuler ce score : le tour suivant est déjà généré",
          "This score cannot be cancelled because the next round has already been generated"
        )
      );

    }

  }

}

    await run(
      `
      UPDATE matches
      SET score1=NULL,
          score2=NULL,
          penalty1=NULL,
          penalty2=NULL,
          winner_id=NULL,
          loser_id=NULL,
          proof_photo='',
          played=0
      WHERE id=?
      `,
      [matchId]
    );

    return res.send(
      tr(
        req,
        "Score annulé",
        "Score cancelled"
      )
    );

  }catch(e){

    console.error(
      "Erreur annulation score :",
      e
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur annulation score",
        "Failed to cancel score"
      )
    );

  }

});

function genererGroupesAuto(participants){

  const total =
    participants.length;

  let nombreGroupes;

  if(total === 48){

    nombreGroupes = 12;

  }else if(total <= 8){

    /*
      6 joueurs → 3 + 3
      7 joueurs → 4 + 3
      8 joueurs → 4 + 4
    */
    nombreGroupes = 2;

  }else if(total <= 10){

    /*
      9 joueurs → 3 + 3 + 3
      10 joueurs → 4 + 3 + 3
    */
    nombreGroupes = 3;

  }else if(total <= 30){

    /*
      Groupes équilibrés
      d’environ 4 joueurs.
    */
    nombreGroupes =
      Math.floor(total / 4);

  }else{

    /*
      Groupes équilibrés
      d’environ 5 joueurs.
    */
    nombreGroupes =
      Math.ceil(total / 5);

  }

  const groupes = [];

  for(
    let i = 0;
    i < nombreGroupes;
    i++
  ){

    groupes.push([]);

  }

  const melange =
    [...participants]
      .sort(
        () => Math.random() - 0.5
      );

  let index = 0;

  for(const joueur of melange){

    groupes[index].push(
      joueur
    );

    index++;

    if(
      index >= groupes.length
    ){

      index = 0;

    }

  }

  return groupes;

}

function genererMatchsPoule(equipes){

  const list = [...equipes];

  if(list.length % 2 !== 0){
    list.push(null);
  }

  const rounds = [];
  const n = list.length;

  for(let r=0; r<n-1; r++){

    const matchs = [];

    for(let i=0; i<n/2; i++){

      const a = list[i];
      const b = list[n - 1 - i];

      if(a && b){
        matchs.push([a,b]);
      }

    }

    rounds.push(matchs);

    const fixed = list[0];
    const rest = list.slice(1);

    rest.unshift(rest.pop());

    list.splice(0,list.length,fixed,...rest);

  }

  return rounds;

}


function getRoundNameRapide(nbParticipants){

  if(nbParticipants > 16) return "QUALIF";
  if(nbParticipants > 8) return "8ES";
  if(nbParticipants > 4) return "QUARTS";
  if(nbParticipants > 2) return "DEMIS";

  return "FINALE";

}

function genererMatchsRapide(participants){

  const total = participants.length;

  if(total !== 32){
    return {
      error:"Ce format rapide exige exactement 32 équipes"
    };
  }

  const melange =
    [...participants]
    .sort(()=>Math.random() - 0.5);

  const matchs = [];

  for(let i=0; i<melange.length; i+=2){

    matchs.push({
      player1:melange[i],
      player2:melange[i + 1],
      round:"16ES",
      leg:"ALLER"
    });

    matchs.push({
      player1:melange[i],
      player2:melange[i + 1],
      round:"16ES",
      leg:"RETOUR"
    });

  }

  return {
    round:"16ES",
    matchs,
    byes:[]
  };

}

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

async function tousMatchsPoulesTermines(
  tournamentId
){

  const result = await get(
    `
    SELECT
      COUNT(*) AS total,
      SUM(
        CASE
          WHEN played=1 THEN 1
          ELSE 0
        END
      ) AS joues
    FROM matches
    WHERE tournament_id=?
      AND round='POULE'
    `,
    [tournamentId]
  );

  const total =
    Number(result?.total || 0);

  const joues =
    Number(result?.joues || 0);

  return (
    total > 0 &&
    total === joues
  );

}
function nombreQualifiesPourGroupes(
  nombreGroupes
){

  if(nombreGroupes <= 0){
    return 0;
  }

  /*
    Format spécial :
    12 groupes de 4
    → 32 qualifiés.
  */
  if(nombreGroupes === 12){
    return 32;
  }

  /*
    On souhaite environ deux qualifiés
    par groupe, puis on choisit la puissance
    de 2 immédiatement inférieure.
  */
  const nombreSouhaite =
    nombreGroupes * 2;

  if(nombreSouhaite >= 32){
    return 32;
  }

  if(nombreSouhaite >= 16){
    return 16;
  }

  if(nombreSouhaite >= 8){
    return 8;
  }

  if(nombreSouhaite >= 4){
    return 4;
  }

  return 2;

}
async function recupererQualifiesPoules(
  tournamentId
){

  const groupes =
    await classementPoules(
      tournamentId
    );

  const nomsGroupes =
    Object
      .keys(groupes)
      .filter(
        nom =>
          nom !== "Sans groupe"
      )
      .sort();

  const nombreCible =
    nombreQualifiesPourGroupes(
      nomsGroupes.length
    );

  if(nombreCible === 0){
    return [];
  }

  const premiers = [];
  const deuxiemes = [];
  const troisiemes = [];
  const autres = [];

  for(const nomGroupe of nomsGroupes){

    const classement =
      groupes[nomGroupe];

    if(!Array.isArray(classement)){
      continue;
    }

    classement.forEach(
      (joueur,index)=>{

        const qualifie = {
          ...joueur,
          groupe:nomGroupe,
          positionGroupe:index + 1
        };

        if(index === 0){

          premiers.push(
            qualifie
          );

        }else if(index === 1){

          deuxiemes.push(
            qualifie
          );

        }else if(index === 2){

          troisiemes.push(
            qualifie
          );

        }else{

          autres.push(
            qualifie
          );

        }

      }
    );

  }

  function comparerJoueurs(a,b){

    return (
      b.pts - a.pts ||
      b.diff - a.diff ||
      b.bp - a.bp ||
      b.v - a.v ||
      a.bc - b.bc ||
      String(a.prenom || "")
        .localeCompare(
          String(b.prenom || "")
        )
    );

  }

  deuxiemes.sort(
    comparerJoueurs
  );

  troisiemes.sort(
    comparerJoueurs
  );

  autres.sort(
    comparerJoueurs
  );

  const qualifies = [];

  /*
    Tous les premiers de groupe
    sont qualifiés en priorité.
  */
  qualifies.push(
    ...premiers
  );

  /*
    On complète avec les meilleurs
    deuxièmes.
  */
  for(const joueur of deuxiemes){

    if(
      qualifies.length >=
      nombreCible
    ){
      break;
    }

    qualifies.push(
      joueur
    );

  }

  /*
    Format 48 équipes ou si nécessaire :
    on complète avec les meilleurs troisièmes.
  */
  for(const joueur of troisiemes){

    if(
      qualifies.length >=
      nombreCible
    ){
      break;
    }

    qualifies.push(
      joueur
    );

  }

  /*
    Sécurité pour un format inhabituel.
  */
  for(const joueur of autres){

    if(
      qualifies.length >=
      nombreCible
    ){
      break;
    }

    qualifies.push(
      joueur
    );

  }

  return qualifies.slice(
    0,
    nombreCible
  );

}

async function creerPremierTourPhaseFinale(
  tournamentId,
  qualifies
){

  if(
    !Array.isArray(qualifies) ||
    qualifies.length < 2
  ){
    throw new Error(
      "Nombre de qualifiés insuffisant"
    );
  }

  const premierTour =
    determinerPremierTourFinal(
      qualifies.length
    );

  if(!premierTour){

    throw new Error(
      "Nombre de qualifiés incompatible avec une phase finale"
    );

  }

  const dejaCree = await get(
    `
    SELECT COUNT(*) AS total
    FROM matches
    WHERE tournament_id=?
      AND round=?
    `,
    [
      tournamentId,
      premierTour
    ]
  );

  if(
    Number(dejaCree?.total || 0) > 0
  ){

    return {
      created:false,
      round:premierTour
    };

  }

  /*
    Mélange des qualifiés.
    On pourra ensuite améliorer les confrontations
    pour éviter deux joueurs du même groupe.
  */
  const melange =
    [...qualifies]
      .sort(
        () => Math.random() - 0.5
      );

  let matchOrder = 1;

  for(
    let index = 0;
    index < melange.length;
    index += 2
  ){

    const joueur1 =
      melange[index];

    const joueur2 =
      melange[index + 1];

    if(!joueur1 || !joueur2){
      continue;
    }

    await run(
      `
      INSERT INTO matches(
        tournament_id,
        round,
        match_order,
        journee,
        player1_id,
        player2_id
      )
      VALUES(?,?,?,?,?,?)
      `,
      [
        tournamentId,
        premierTour,
        matchOrder++,
        "ALLER",
        joueur1.id,
        joueur2.id
      ]
    );

    await run(
      `
      INSERT INTO matches(
        tournament_id,
        round,
        match_order,
        journee,
        player1_id,
        player2_id
      )
      VALUES(?,?,?,?,?,?)
      `,
      [
        tournamentId,
        premierTour,
        matchOrder++,
        "RETOUR",
        joueur1.id,
        joueur2.id
      ]
    );

  }

  return {
    created:true,
    round:premierTour
  };

}

async function genererTourSuivantPhaseFinale(
  tournamentId,
  round
){

  const nextRound =
    getNextRoundRapide(round);

  if(!nextRound){

    return {
      created:false,
      finished:true
    };

  }

  const matchs = await all(
    `
    SELECT *
    FROM matches
    WHERE tournament_id=?
      AND round=?
    ORDER BY match_order ASC, id ASC
    `,
    [
      tournamentId,
      round
    ]
  );

  if(matchs.length === 0){

    throw new Error(
      "Aucun match trouvé pour ce tour"
    );

  }

  const duels = new Map();

  for(const match of matchs){

    const ordreDuel =
      Math.ceil(
        Number(match.match_order || 1) / 2
      );

    if(!duels.has(ordreDuel)){

      duels.set(
        ordreDuel,
        {
          aller:null,
          retour:null
        }
      );

    }

    const duel =
      duels.get(ordreDuel);

    if(
      match.journee === "ALLER" ||
      match.leg === "ALLER"
    ){

      duel.aller = match;

    }

    if(
      match.journee === "RETOUR" ||
      match.leg === "RETOUR"
    ){

      duel.retour = match;

    }

  }

  const gagnants = [];

  for(const [ordreDuel, duel] of duels){

    if(
      !duel.aller ||
      !duel.retour ||
      Number(duel.aller.played) !== 1 ||
      Number(duel.retour.played) !== 1
    ){

      return {
        created:false,
        incomplete:true
      };

    }

    const player1 =
      Number(duel.aller.player1_id);

    const player2 =
      Number(duel.aller.player2_id);

    function scoreDuJoueur(match, playerId){

      if(
        Number(match.player1_id) === playerId
      ){
        return Number(match.score1 || 0);
      }

      if(
        Number(match.player2_id) === playerId
      ){
        return Number(match.score2 || 0);
      }

      return 0;

    }

    const total1 =
      scoreDuJoueur(
        duel.aller,
        player1
      ) +
      scoreDuJoueur(
        duel.retour,
        player1
      );

    const total2 =
      scoreDuJoueur(
        duel.aller,
        player2
      ) +
      scoreDuJoueur(
        duel.retour,
        player2
      );

    let winnerId = null;

    if(total1 > total2){

      winnerId = player1;

    }else if(total2 > total1){

      winnerId = player2;

    }else{

      const penalty1 =
        duel.retour.penalty1 === null ||
        duel.retour.penalty1 === undefined
          ? null
          : Number(
              duel.retour.penalty1
            );

      const penalty2 =
        duel.retour.penalty2 === null ||
        duel.retour.penalty2 === undefined
          ? null
          : Number(
              duel.retour.penalty2
            );

      if(
        penalty1 === null ||
        penalty2 === null
      ){

        return {
          created:false,
          penaltiesMissing:true
        };

      }

      winnerId =
        penalty1 > penalty2
          ? Number(
              duel.retour.player1_id
            )
          : Number(
              duel.retour.player2_id
            );

    }

    gagnants.push({
      ordreDuel,
      playerId:winnerId
    });

  }

  gagnants.sort(
    (a,b) =>
      a.ordreDuel - b.ordreDuel
  );

  const dejaCree = await get(
    `
    SELECT COUNT(*) AS total
    FROM matches
    WHERE tournament_id=?
      AND round=?
    `,
    [
      tournamentId,
      nextRound
    ]
  );

  if(
    Number(dejaCree?.total || 0) > 0
  ){

    return {
      created:false,
      alreadyCreated:true,
      round:nextRound
    };

  }

  let matchOrder = 1;

  for(
    let index = 0;
    index < gagnants.length;
    index += 2
  ){

    const joueur1 =
      gagnants[index];

    const joueur2 =
      gagnants[index + 1];

    if(!joueur1 || !joueur2){
      continue;
    }

    await run(
      `
      INSERT INTO matches(
        tournament_id,
        round,
        match_order,
        journee,
        player1_id,
        player2_id
      )
      VALUES(?,?,?,?,?,?)
      `,
      [
        tournamentId,
        nextRound,
        matchOrder++,
        "ALLER",
        joueur1.playerId,
        joueur2.playerId
      ]
    );

    await run(
      `
      INSERT INTO matches(
        tournament_id,
        round,
        match_order,
        journee,
        player1_id,
        player2_id
      )
      VALUES(?,?,?,?,?,?)
      `,
      [
        tournamentId,
        nextRound,
        matchOrder++,
        "RETOUR",
        joueur1.playerId,
        joueur2.playerId
      ]
    );

  }

  return {
    created:true,
    round:nextRound
  };

}

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




.wc-wrap{
  width:100%;
  overflow:auto;
  padding:20px 0 70px;
}

.wc-board{
  position:relative;
  width:2050px;
  min-height:1850px;
  background:#020617;
}

.wc-lines{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  pointer-events:none;
  z-index:1;
}

.wc-lines path{
  stroke:#e5e7eb;
  stroke-width:3;
  fill:none;
}

.wc-col{
  position:absolute;
  width:270px;
  z-index:2;
}

.wc-title{
  text-align:center;
  color:#60a5fa;
  font-size:22px;
  font-weight:900;
  margin-bottom:16px;
}

.wc-match{
  position:absolute;
  width:330px;
  min-height:92px;
  background:#0f172a;
  border:1px solid #2563eb;
  border-radius:10px;
  padding:10px;
  box-sizing:border-box;
}

.wc-player{
  display:flex;
  justify-content:space-between;
  align-items:center;
  font-weight:900;
  margin:5px 0;
}

.wc-player.winner{
  color:#22c55e;
}

.wc-score{
  color:#facc15;
}

.wc-total{
  color:#facc15;
  text-align:center;
  font-weight:900;
  font-size:13px;
  margin-top:8px;
}

.wc-status{
  text-align:center;
  color:#cbd5e1;
  font-size:12px;
  margin-top:6px;
}

.wc-champion{
  background:linear-gradient(135deg,#f59e0b,#fde047);
  color:#111827;
  text-align:center;
  font-size:22px;
  font-weight:900;
}

.wc-score small{
  font-size:10px;
  color:#94a3b8;
  font-weight:700;
  margin:0 4px;
}

@media(max-width:768px){

  .wc-wrap{
    overflow:auto;
    min-height:1150px;
  }

  .wc-board{
    transform:scale(.75);
    transform-origin:top left;
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

function regrouperDuelsPublic(matchs){

  const duels = {};

  matchs.forEach(m=>{

    if(m.round === "POULE") return;

    const key =
      [m.player1_id,m.player2_id]
      .sort((a,b)=>Number(a)-Number(b))
      .join("_");

    const ordreDuel =
      Math.ceil(Number(m.match_order || m.id || 1) / 2);

    if(!duels[key]){
      duels[key] = {
        order:ordreDuel,
        player1_id:m.player1_id,
        player2_id:m.player2_id,
        player1_name:m.player1_name,
        player2_name:m.player2_name,
        aller:null,
        retour:null
      };
    }

    if(m.journee === "ALLER" || m.leg === "ALLER"){
      duels[key].aller = m;
    }

    if(m.journee === "RETOUR" || m.leg === "RETOUR"){
      duels[key].retour = m;
    }

  });

  return Object.values(duels).sort((a,b)=>a.order-b.order);
}

function duelPublicHtml(d){

  if(!d){
    return `
      <div class="public-match">
        <div class="public-player">
          <span>À déterminer</span>
          <span class="public-score">Aller - Retour -</span>
        </div>

        <div class="public-player">
          <span>À déterminer</span>
          <span class="public-score">Aller - Retour -</span>
        </div>

        <div class="public-status">⏳ En attente</div>
      </div>
    `;
  }

  const a = d.aller;
  const r = d.retour;

  const playedAller = a && Number(a.played) === 1;
  const playedRetour = r && Number(r.played) === 1;

  const total1 =
    (playedAller ? Number(a.score1 || 0) : 0) +
    (playedRetour ? Number(r.score1 || 0) : 0);

  const total2 =
    (playedAller ? Number(a.score2 || 0) : 0) +
    (playedRetour ? Number(r.score2 || 0) : 0);

  const winnerId =
    Number(r?.winner_id || a?.winner_id || 0);

  return `
    <div class="public-match">

      <div class="public-player ${winnerId === Number(d.player1_id) ? "winner" : ""}">
        <span>${escapeHtml(d.player1_name || "À déterminer")}</span>
        <span class="public-score">
          Aller ${playedAller ? a.score1 : "-"}
          Retour ${playedRetour ? r.score1 : "-"}
        </span>
      </div>

      <div class="public-player ${winnerId === Number(d.player2_id) ? "winner" : ""}">
        <span>${escapeHtml(d.player2_name || "À déterminer")}</span>
        <span class="public-score">
          Aller ${playedAller ? a.score2 : "-"}
          Retour ${playedRetour ? r.score2 : "-"}
        </span>
      </div>

      <div class="public-total">Total : ${total1} - ${total2}</div>

      <div class="public-status">
        ${playedAller && playedRetour ? "✅ Duel terminé" : "⏳ En attente"}
      </div>

    </div>
  `;
}

const ordrePublic = ["16ES","8ES","QUARTS","DEMIS","FINALE"];

const nombrePublic = {
  "16ES":16,
  "8ES":8,
  "QUARTS":4,
  "DEMIS":2,
  "FINALE":1
};

function afficherArbrePublic(){

  const data = [];

  const ordre = ["16ES","8ES","QUARTS","DEMIS","FINALE"];

  ordre.forEach(tour=>{
    data.push({
      tour,
      matchs: matches.filter(m => m.round === tour)
    });
  });

  function regrouperDuels(matchs){

    const duels = {};

    matchs.forEach(m=>{

      const key =
        [m.player1_id, m.player2_id]
        .sort((a,b)=>Number(a)-Number(b))
        .join("_");

      const ordreDuel =
        Math.ceil(Number(m.match_order || m.id || 1) / 2);

      if(!duels[key]){
        duels[key] = {
          order:ordreDuel,
          player1_id:m.player1_id,
          player2_id:m.player2_id,
          player1_name:m.player1_name,
          player2_name:m.player2_name,
          aller:null,
          retour:null
        };
      }

      if(m.journee === "ALLER" || m.leg === "ALLER"){
        duels[key].aller = m;
      }

      if(m.journee === "RETOUR" || m.leg === "RETOUR"){
        duels[key].retour = m;
      }

    });

    return Object.values(duels).sort((a,b)=>a.order-b.order);
  }

  function duelHtml(d){

    if(!d){
      return `
        <div class="wc-player">
          <span>À déterminer</span>
          <span class="wc-score"><small>Aller</small> - <small>Retour</small> -</span>
        </div>
        <div class="wc-player">
          <span>À déterminer</span>
          <span class="wc-score"><small>Aller</small> - <small>Retour</small> -</span>
        </div>
        <div class="wc-status">En attente</div>
      `;
    }

    const a = d.aller;
    const r = d.retour;

    const playedAller = a && Number(a.played) === 1;
    const playedRetour = r && Number(r.played) === 1;

    const total1 =
      (playedAller ? Number(a.score1 || 0) : 0) +
      (playedRetour ? Number(r.score1 || 0) : 0);

    const total2 =
      (playedAller ? Number(a.score2 || 0) : 0) +
      (playedRetour ? Number(r.score2 || 0) : 0);

    const winnerId = Number(r?.winner_id || a?.winner_id || 0);

    return `
      <div class="wc-player ${winnerId === Number(d.player1_id) ? "winner" : ""}">
        <span>${escapeHtml(d.player1_name || "À déterminer")}</span>
        <span class="wc-score">
          <small>Aller</small> ${playedAller ? a.score1 : "-"}
          <small>Retour</small> ${playedRetour ? r.score1 : "-"}
        </span>
      </div>

      <div class="wc-player ${winnerId === Number(d.player2_id) ? "winner" : ""}">
        <span>${escapeHtml(d.player2_name || "À déterminer")}</span>
        <span class="wc-score">
          <small>Aller</small> ${playedAller ? a.score2 : "-"}
          <small>Retour</small> ${playedRetour ? r.score2 : "-"}
        </span>
      </div>

      <div class="wc-total">Total : ${total1} - ${total2}</div>
      <div class="wc-status">
        ${playedAller && playedRetour ? "✅ Duel terminé" : "⏳ En attente"}
      </div>
    `;
  }

  const config = {
    "16ES":  { x:20,   count:16, gap:110 },
    "8ES":   { x:500,  count:8,  gap:220 },
    "QUARTS":{ x:920,  count:4,  gap:440 },
    "DEMIS": { x:1300, count:2,  gap:880 },
    "FINALE":{ x:1650, count:1,  gap:0 }
  };

  const topStart = 70;
  const roundsData = {};

  ordre.forEach(tour=>{
    const bloc = data.find(x => x.tour === tour);
    roundsData[tour] = bloc ? regrouperDuels(bloc.matchs) : [];
  });

  let htmlRounds = "";

  ordre.forEach(tour=>{

    const c = config[tour];

    htmlRounds += `
      <div class="wc-col" style="left:${c.x}px;top:0;">
        <div class="wc-title">${tour}</div>
    `;

    for(let i=0; i<c.count; i++){

      const y = topStart + i * c.gap;
      const duel = roundsData[tour][i];

      htmlRounds += `
        <div class="wc-match" id="wc-${tour}-${i}" style="top:${y}px;">
          ${duelHtml(duel)}
        </div>
      `;
    }

    htmlRounds += `</div>`;

  });

  return `
    <div class="card">
      <h2>🌳 Arbre du tournoi</h2>

      <div class="wc-wrap">
        <div class="wc-board" id="wcBoard">

          <svg class="wc-lines" id="wcLines"></svg>

          ${htmlRounds}

          <div class="wc-col" style="left:1480px;top:0;">
            <div class="wc-title">CHAMPION</div>

            <div class="wc-match wc-champion" id="wcChampion" style="top:560px;">
              🏆<br><br>
              ${champion && champion.prenom ? escapeHtml(champion.prenom) : "À déterminer"}
            </div>
          </div>

        </div>
      </div>
    </div>
  `;
}

html += afficherArbrePublic();

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
function drawWorldCupLines(){

  const board = document.getElementById("wcBoard");
  const svg = document.getElementById("wcLines");

  if(!board || !svg) return;

  svg.innerHTML = "";
  svg.setAttribute("width", board.scrollWidth);
  svg.setAttribute("height", board.scrollHeight);

  function getPos(el){

    let x = 0;
    let y = 0;
    let current = el;

    while(current && current !== board){
      x += current.offsetLeft;
      y += current.offsetTop;
      current = current.offsetParent;
    }

    return {
      left:x,
      right:x + el.offsetWidth,
      centerY:y + el.offsetHeight / 2
    };

  }

  function path(d){

    const p = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );

    p.setAttribute("d", d);
    svg.appendChild(p);

  }

  function connect(aEl, bEl, toEl){

    if(!aEl || !bEl || !toEl) return;

    const a = getPos(aEl);
    const b = getPos(bEl);
    const to = getPos(toEl);

    const x1 = a.right;
    const x2 = to.left;
    const joinX = x1 + 35;
    const midY = (a.centerY + b.centerY) / 2;
    const endX = x2 - 35;

    path(\`M \${x1} \${a.centerY} H \${joinX}\`);
    path(\`M \${b.right} \${b.centerY} H \${joinX}\`);
    path(\`M \${joinX} \${a.centerY} V \${b.centerY}\`);
    path(\`M \${joinX} \${midY} H \${endX} V \${to.centerY} H \${x2}\`);

  }

  const schema = [
    ["16ES", "8ES", 16],
    ["8ES", "QUARTS", 8],
    ["QUARTS", "DEMIS", 4],
    ["DEMIS", "FINALE", 2]
  ];

  schema.forEach(([from,to,count])=>{

    for(let i = 0; i < count; i += 2){

      connect(
        document.getElementById(\`wc-\${from}-\${i}\`),
        document.getElementById(\`wc-\${from}-\${i + 1}\`),
        document.getElementById(\`wc-\${to}-\${i / 2}\`)
      );

    }

  });

  const finale = document.getElementById("wc-FINALE-0");
  const champion = document.getElementById("wcChampion");

  if(finale && champion){

    const a = getPos(finale);
    const b = getPos(champion);

    path(\`M \${a.right} \${a.centerY} H \${b.left}\`);

  }

}

requestAnimationFrame(()=>{
  requestAnimationFrame(()=>{
    drawWorldCupLines();
  });
});

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

app.post(
  "/upload-image",
  uploadLimiter,
  (req,res)=>{

    if(!connected(req)){

      return res.status(401).json({
        ok:false,
        message:tr(
          req,
          "Connecte-toi pour envoyer un fichier",
          "Log in to upload a file"
        )
      });

    }

    upload.single("image")(
      req,
      res,
      async (err)=>{

    try{

      if(err){
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

      const ext =
        path.extname(req.file.originalname).toLowerCase();

      const fileName =
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2) +
        ext;

      console.log("UPLOAD R2 FILE:", fileName);
      console.log("BUCKET:", process.env.R2_BUCKET);
      console.log("FILE SIZE:", req.file.size);

      await r2.send(
        new PutObjectCommand({
          Bucket:process.env.R2_BUCKET,
          Key:fileName,
          Body:req.file.buffer,
          ContentType:req.file.mimetype
        })
      );

      const url =
        `${process.env.R2_PUBLIC_URL}/${fileName}`;

      let thumbnail_url = "";

     if(req.file.mimetype.startsWith("video/")){

  const tempVideo =
    path.join(os.tmpdir(), fileName);

  const thumbName =
    fileName.replace(/\.[^/.]+$/, "") + ".jpg";

  const tempThumb =
    path.join(os.tmpdir(), thumbName);

  try{

    fs.writeFileSync(
      tempVideo,
      req.file.buffer
    );

    await new Promise((resolve,reject)=>{

      execFile(
        "ffmpeg",
        [
          "-y",
          "-i", tempVideo,
          "-frames:v", "1",
          "-q:v", "2",
          tempThumb
        ],
        error =>{

          if(error){
            reject(error);
            return;
          }

          resolve();

        }
      );

    });

    if(fs.existsSync(tempThumb)){

      const thumbBuffer =
        fs.readFileSync(tempThumb);

      await r2.send(
        new PutObjectCommand({
          Bucket:process.env.R2_BUCKET,
          Key:thumbName,
          Body:thumbBuffer,
          ContentType:"image/jpeg"
        })
      );

      thumbnail_url =
        `${process.env.R2_PUBLIC_URL}/${thumbName}`;

    }

  }catch(error){

    console.error(
      "Erreur création miniature :",
      error
    );

    /*
      La vidéo reste envoyée même si la
      miniature ne peut pas être créée.
    */
    thumbnail_url = "";

  }finally{

    if(fs.existsSync(tempVideo)){
      fs.unlinkSync(tempVideo);
    }

    if(fs.existsSync(tempThumb)){
      fs.unlinkSync(tempThumb);
    }

  }

}
      console.log("UPLOAD URL =", url);
      console.log("UPLOAD THUMB =", thumbnail_url);

      res.json({
        ok:true,
        url,
        thumbnail_url
      });

    }catch(e){

      console.log(e);

      res.status(500).json({
        ok:false,
        message:"Erreur upload R2"
      });

    }

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
      <form method="POST" action="/admin-valider-paiement">
        <input type="hidden" name="payment_id" value="${p.id}">
        <input type="hidden" name="user_id" value="${p.user_id}">
        <button>Valider abonnement 1 mois</button>
      </form>
     <form method="POST" action="/admin-refuser-paiement"> 
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

app.post(
  "/admin-valider-paiement",
  async (req,res)=>{

    try{

      if(!isAdmin(req)){

        return res
          .status(403)
          .send("Accès admin refusé");

      }

      const {
        payment_id,
        user_id
      } = req.body;

      if(!payment_id || !user_id){

        return res
          .status(400)
          .send(
            "Paiement et utilisateur obligatoires"
          );

      }

      const paiement = await get(
        `
        SELECT *
        FROM payments
        WHERE id=?
        AND user_id=?
        `,
        [
          payment_id,
          user_id
        ]
      );

      if(!paiement){

        return res
          .status(404)
          .send("Paiement introuvable");

      }

      if(paiement.status === "approved"){

        return res.redirect(
          "/admin-payments?admin=" +
          encodeURIComponent(
            ADMIN_PASSWORD
          )
        );

      }

      await run("BEGIN TRANSACTION");

      try{

        await run(
          `
          UPDATE users
          SET abonnement=1,
              abonnement_expire_at=
                datetime('now','+30 days')
          WHERE id=?
          `,
          [user_id]
        );

        await run(
          `
          UPDATE payments
          SET status='approved'
          WHERE id=?
          AND user_id=?
          `,
          [
            payment_id,
            user_id
          ]
        );

        await run("COMMIT");

      }catch(error){

        await run("ROLLBACK");

        throw error;

      }

      return res.redirect(
        "/admin-payments?admin=" +
        encodeURIComponent(
          ADMIN_PASSWORD
        )
      );

    }catch(e){

      console.error(
        "Erreur validation paiement :",
        e
      );

      return res
        .status(500)
        .send(
          "Erreur validation paiement"
        );

    }

  }
);

app.post(
  "/admin-refuser-paiement",
  async (req,res)=>{

    try{

      if(!isAdmin(req)){

        return res
          .status(403)
          .send("Accès admin refusé");

      }

      const paymentId =
        Number(req.body.payment_id);

      const userId =
        Number(req.body.user_id);

      if(
        !Number.isInteger(paymentId) ||
        paymentId <= 0 ||
        !Number.isInteger(userId) ||
        userId <= 0
      ){

        return res
          .status(400)
          .send(
            "Paiement ou utilisateur invalide"
          );

      }

      const paiement = await get(
        `
        SELECT id, user_id, status
        FROM payments
        WHERE id=?
          AND user_id=?
        `,
        [
          paymentId,
          userId
        ]
      );

      if(!paiement){

        return res
          .status(404)
          .send(
            "Paiement introuvable"
          );

      }

      if(paiement.status === "approved"){

        return res
          .status(409)
          .send(
            "Un paiement déjà validé ne peut pas être refusé"
          );

      }

      await run(
        `
        UPDATE payments
        SET status='refused'
        WHERE id=?
          AND user_id=?
        `,
        [
          paymentId,
          userId
        ]
      );

      return res.redirect(
        "/admin-payments"
      );

    }catch(error){

      console.error(
        "Erreur refus paiement :",
        error
      );

      return res
        .status(500)
        .send(
          "Erreur refus paiement"
        );

    }

  }
);

app.get("/download-db",(req,res)=>{

  try{

    if(!isAdmin(req)){

      return res
        .status(403)
        .send("Accès admin refusé");

    }

    const dbPath =
      path.join(
        DATA_DIR,
        "database.sqlite"
      );

    if(!fs.existsSync(dbPath)){

      return res
        .status(404)
        .send(
          "Base de données introuvable"
        );

    }

    return res.download(
      dbPath,
      "snugame-backup.sqlite",
      error =>{

        if(error){

          console.error(
            "Erreur téléchargement base :",
            error
          );

          if(!res.headersSent){

            res
              .status(500)
              .send(
                "Erreur téléchargement base"
              );

          }

        }

      }
    );

  }catch(error){

    console.error(
      "Erreur route download-db :",
      error
    );

    return res
      .status(500)
      .send(
        "Erreur téléchargement base"
      );

  }

});

app.post("/highlight", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.send("Connecte-toi");
    }

    const {
      titre,
      description,
      media_url,
      thumbnail_url
    } = req.body;

    if(!titre || !media_url){
      return res.send("Titre et média obligatoires");
    }

    console.log("VIDEO =", media_url);
    console.log("THUMB =", thumbnail_url);

    await run(
      `
      INSERT INTO highlights(
        user_id,
        titre,
        description,
        media_url,
        thumbnail_url
      )
      VALUES(?,?,?,?,?)
      `,
      [
        req.session.userId,
        titre,
        description || "",
        media_url,
        thumbnail_url || ""
      ]
    );

    res.send("Vidéo publiée");

  }catch(e){

    console.log(e);
    res.send("Erreur ajout vidéo");

  }

});

app.get("/highlights", async (req,res)=>{

  try{

    const userId =
      req.session.userId || 0;

    const highlights = await all(
      `
      SELECT
        h.*,
        u.username,
        u.name,
        u.profile_photo,

        CASE
          WHEN hl.id IS NULL THEN 0
          ELSE 1
        END AS liked,

        CASE
          WHEN vf.id IS NULL THEN 0
          ELSE 1
        END AS favorited,

        (
          SELECT COUNT(*)
          FROM highlight_comments hc
          WHERE hc.highlight_id = h.id
        ) AS comments

        ,
       (
        SELECT COUNT(*)
        FROM video_favorites vf2
        WHERE vf2.highlight_id = h.id
       ) AS favorites

      FROM highlights h

      LEFT JOIN users u
        ON u.id = h.user_id

      LEFT JOIN highlight_likes hl
        ON hl.highlight_id = h.id
        AND hl.user_id = ?

      LEFT JOIN video_favorites vf
        ON vf.highlight_id = h.id
        AND vf.user_id = ?

      ORDER BY
     (
      (h.vues * 1) +
     (h.likes * 5) +

     (
       SELECT COUNT(*)
       FROM highlight_comments hc
       WHERE hc.highlight_id = h.id
      ) * 8 +

     (
       SELECT COUNT(*)
       FROM video_favorites vf2
       WHERE vf2.highlight_id = h.id
      ) * 10 +

     (
       SELECT COALESCE(SUM(seconds),0)
       FROM video_watch_time wt
       WHERE wt.highlight_id = h.id
      ) * 1 +

     (
       SELECT COUNT(*)
       FROM video_watch_time wt2
       WHERE wt2.highlight_id = h.id
      AND wt2.percent >= 80
     ) * 25
     ) DESC,
      h.id DESC
      `,
      [
        userId,
        userId
      ]
    );

    res.json(
      highlights.map(h=>({
        ...h,
        current_user_id:req.session.userId
      }))
    );

  }catch(e){

    console.log(e);
    res.send("Erreur highlights");

  }

});

app.post("/like-highlight", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const highlightId =
      Number(req.body.id);

    if(
      !Number.isInteger(highlightId) ||
      highlightId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Vidéo invalide",
          "Invalid video"
        )
      );

    }

    const video = await get(
      `
      SELECT
        h.id,
        h.user_id,
        h.titre,
        u.username,
        u.name
      FROM highlights h
      LEFT JOIN users u
        ON u.id=?
      WHERE h.id=?
      `,
      [
        req.session.userId,
        highlightId
      ]
    );

    if(!video){

      return res.status(404).send(
        tr(
          req,
          "Vidéo introuvable",
          "Video not found"
        )
      );

    }

    const dejaLike = await get(
      `
      SELECT id
      FROM highlight_likes
      WHERE highlight_id=?
        AND user_id=?
      `,
      [
        highlightId,
        req.session.userId
      ]
    );

    await run("BEGIN TRANSACTION");

    try{

      if(dejaLike){

        await run(
          `
          DELETE FROM highlight_likes
          WHERE highlight_id=?
            AND user_id=?
          `,
          [
            highlightId,
            req.session.userId
          ]
        );

        await run(
          `
          UPDATE highlights
          SET likes=MAX(likes-1,0)
          WHERE id=?
          `,
          [highlightId]
        );

        await run("COMMIT");

        return res.send(
          tr(
            req,
            "Like retiré",
            "Like removed"
          )
        );

      }

      await run(
        `
        INSERT INTO highlight_likes(
          highlight_id,
          user_id
        )
        VALUES(?,?)
        `,
        [
          highlightId,
          req.session.userId
        ]
      );

      await run(
        `
        UPDATE highlights
        SET likes=likes+1
        WHERE id=?
        `,
        [highlightId]
      );

      await run("COMMIT");

    }catch(error){

      await run("ROLLBACK");
      throw error;

    }

    if(
      video.user_id &&
      Number(video.user_id) !==
      Number(req.session.userId)
    ){

      await notifierUtilisateur(
        video.user_id,
        "❤️ Nouveau like",
        `${video.username || video.name || "Un joueur"} a aimé ta vidéo`,
        `video:${highlightId}`
      );

    }

    return res.send(
      tr(
        req,
        "Like ajouté",
        "Like added"
      )
    );

  }catch(error){

    console.error(
      "Erreur like vidéo :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur like",
        "Failed to like video"
      )
    );

  }

});

app.post("/view-highlight", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.json({
        ok:false,
        message:"Non connecté"
      });
    }

    const { id } = req.body;

    if(!id){
      return res.json({
        ok:false,
        message:"Vidéo manquante"
      });
    }

    const inserted = await run(
      `
      INSERT OR IGNORE INTO highlight_views(
        user_id,
        highlight_id
      )
      VALUES(?,?)
      `,
      [
        req.session.userId,
        id
      ]
    );

    if(inserted.changes > 0){

      await run(
        `
        UPDATE highlights
        SET vues = vues + 1
        WHERE id=?
        `,
        [id]
      );

    }

    const video = await get(
      `
      SELECT vues
      FROM highlights
      WHERE id=?
      `,
      [id]
    );

    res.json({
      ok:true,
      counted: inserted.changes > 0,
      vues: video ? video.vues : 0
    });

  }catch(e){

    console.log(e);

    res.json({
      ok:false
    });

  }

});

app.get(
  "/comments-highlight/:id",
  async (req,res)=>{

    try{

      const highlightId =
        Number(req.params.id);

      if(
        !Number.isInteger(highlightId) ||
        highlightId <= 0
      ){

        return res.status(400).json({
          ok:false,
          message:tr(
            req,
            "Vidéo invalide",
            "Invalid video"
          )
        });

      }

      const video = await get(
        `
        SELECT id
        FROM highlights
        WHERE id=?
        `,
        [highlightId]
      );

      if(!video){

        return res.status(404).json({
          ok:false,
          message:tr(
            req,
            "Vidéo introuvable",
            "Video not found"
          )
        });

      }

      const comments = await all(
        `
        SELECT
          c.id,
          c.highlight_id,
          c.user_id,
          c.comment,
          c.created_at,
          u.name,
          u.username,
          u.profile_photo
        FROM highlight_comments c
        LEFT JOIN users u
          ON u.id=c.user_id
        WHERE c.highlight_id=?
        ORDER BY c.id DESC
        LIMIT 200
        `,
        [highlightId]
      );

      return res.json(comments);

    }catch(error){

      console.error(
        "Erreur chargement commentaires :",
        error
      );

      return res.status(500).json({
        ok:false,
        message:tr(
          req,
          "Impossible de charger les commentaires",
          "Failed to load comments"
        )
      });

    }

  }
);

app.post("/follow-player", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi d'abord",
          "Please log in first"
        )
      );

    }

    const playerUserId =
      Number(req.body.player_user_id);

    if(
      !Number.isInteger(playerUserId) ||
      playerUserId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Joueur invalide",
          "Invalid player"
        )
      );

    }

    if(
      playerUserId ===
      Number(req.session.userId)
    ){

      return res.status(400).send(
        tr(
          req,
          "Tu ne peux pas te suivre toi-même",
          "You cannot follow yourself"
        )
      );

    }

    const player = await get(
      `
      SELECT id
      FROM users
      WHERE id=?
      `,
      [playerUserId]
    );

    if(!player){

      return res.status(404).send(
        tr(
          req,
          "Joueur introuvable",
          "Player not found"
        )
      );

    }

    const existing = await get(
      `
      SELECT id
      FROM follows
      WHERE follower_id=?
        AND following_participant_id=?
      `,
      [
        req.session.userId,
        playerUserId
      ]
    );

    if(existing){

      await run(
        `
        DELETE FROM follows
        WHERE id=?
        `,
        [existing.id]
      );

      return res.send("Unfollow");

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
        playerUserId
      ]
    );

    const me = await get(
      `
      SELECT username, name
      FROM users
      WHERE id=?
      `,
      [req.session.userId]
    );

    await notifierUtilisateur(
      playerUserId,
      "🔔 Nouvel abonné",
      `${me?.username || me?.name || "Un joueur"} s'est abonné à toi`,
      `profile:${req.session.userId}`
    );

    return res.send(
      tr(
        req,
        "Abonnement réussi ✅",
        "Follow successful ✅"
      )
    );

  }catch(error){

    console.error(
      "Erreur abonnement joueur :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur abonnement joueur",
        "Failed to follow player"
      )
    );

  }

});

app.get("/followers/:id", async (req,res)=>{

  try{

    const result = await get(
      `
      SELECT COUNT(*) AS total
      FROM followers
      WHERE following_id=?
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
app.get("/user-followers/:id", async (req,res)=>{

  try{

    const users = await all(
      `
      SELECT
        u.id,
        u.name,
        u.username,
        u.profile_photo
      FROM followers f
      JOIN users u
        ON u.id = f.follower_id
      WHERE f.following_id=?
      ORDER BY f.id DESC
      `,
      [req.params.id]
    );

    res.json(users);

  }catch(e){
    console.log(e);
    res.json([]);
  }

});
app.get("/user-following/:id", async (req,res)=>{

  try{

    const users = await all(
      `
      SELECT
        u.id,
        u.name,
        u.username,
        u.profile_photo
      FROM followers f
      JOIN users u
        ON u.id = f.following_id
      WHERE f.follower_id=?
      ORDER BY f.id DESC
      `,
      [req.params.id]
    );

    res.json(users);

  }catch(e){
    console.log(e);
    res.json([]);
  }

});

app.post(
  "/tirage-automatique-rapide",
  async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const tournamentId =
      Number(req.body.tournament_id);

    if(
      !Number.isInteger(tournamentId) ||
      tournamentId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Tournoi obligatoire ou invalide",
          "Tournament is required or invalid"
        )
      );

    }

    const ownerCheck =
      await verifierProprietaireTournoi(
        req,
        tournamentId
      );

    if(!ownerCheck.ok){

      return res.status(403).send(
        ownerCheck.message
      );

    }

    const tournoi =
      ownerCheck.tournoi;

    if(!tournoi){

      return res.status(404).send(
        tr(
          req,
          "Tournoi introuvable",
          "Tournament not found"
        )
      );

    }

    if(tournoi.type !== "rapide"){

      return res.status(400).send(
        tr(
          req,
          "Ce tournoi n'est pas un tournoi rapide",
          "This tournament is not a quick tournament"
        )
      );

    }

    if(tournoi.status === "finished"){

      return res.status(409).send(
        tr(
          req,
          "Le tournoi est déjà terminé",
          "The tournament is already finished"
        )
      );

    }

    const participants = await all(
      `
      SELECT *
      FROM participants
      WHERE tournament_id=?
      ORDER BY id
      `,
      [tournamentId]
    );

    if(participants.length !== 32){

      return res.status(400).send(
        tr(
          req,
          `Le tournoi rapide exige exactement 32 participants. Actuellement : ${participants.length}/32.`,
          `The quick tournament requires exactly 32 participants. Currently: ${participants.length}/32.`
        )
      );

    }

    const dejaMatchs = await get(
      `
      SELECT COUNT(*) AS total
      FROM matches
      WHERE tournament_id=?
      `,
      [tournamentId]
    );

    if(
      Number(dejaMatchs?.total || 0) > 0
    ){

      return res.status(409).send(
        tr(
          req,
          "Le tirage rapide est déjà généré",
          "The quick-tournament draw has already been generated"
        )
      );

    }

    const tirage =
      genererMatchsRapide(
        participants
      );

    if(
      !tirage ||
      tirage.error ||
      !Array.isArray(tirage.matchs)
    ){

      return res.status(400).send(
        tirage?.error ||
        tr(
          req,
          "Impossible de générer le tournoi rapide",
          "Unable to generate the quick tournament"
        )
      );

    }

    await run("BEGIN TRANSACTION");

    try{

      let matchOrder = 1;

      for(const match of tirage.matchs){

        await run(
          `
          INSERT INTO matches(
            tournament_id,
            round,
            match_order,
            journee,
            player1_id,
            player2_id
          )
          VALUES(?,?,?,?,?,?)
          `,
          [
            tournamentId,
            match.round,
            matchOrder++,
            match.leg,
            match.player1.id,
            match.player2.id
          ]
        );

      }

      await run(
        `
        UPDATE tournaments
        SET status='started'
        WHERE id=?
        `,
        [tournamentId]
      );

      await run("COMMIT");

    }catch(errorTransaction){

      try{
        await run("ROLLBACK");
      }catch(errorRollback){

        console.error(
          "Erreur ROLLBACK tirage rapide :",
          errorRollback
        );

      }

      throw errorTransaction;

    }

    for(const participant of participants){

      if(!participant.user_id){
        continue;
      }

      await notifierUtilisateur(
        participant.user_id,
        "🏆 Début du tournoi",
        `Le tournoi "${tournoi.name}" vient de commencer.`,
        `tournament:${tournamentId}`
      );

    }

    return res.send(
      tr(
        req,
        "Tournoi rapide 32 généré",
        "Quick 32-team tournament generated"
      )
    );

  }catch(error){

    console.error(
      "Erreur tirage rapide :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur pendant la génération du tournoi rapide",
        "Error while generating the quick tournament"
      )
    );

  }

});

app.post(
  "/tirage-automatique-poule-pro",
  async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const tournamentId =
      Number(req.body.tournament_id);

    if(
      !Number.isInteger(tournamentId) ||
      tournamentId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Tournoi obligatoire ou invalide",
          "Tournament is required or invalid"
        )
      );

    }

    const ownerCheck =
      await verifierProprietaireTournoi(
        req,
        tournamentId
      );

    if(!ownerCheck.ok){

      return res.status(403).send(
        ownerCheck.message
      );

    }

    const tournoi =
      ownerCheck.tournoi;

    if(!tournoi){

      return res.status(404).send(
        tr(
          req,
          "Tournoi introuvable",
          "Tournament not found"
        )
      );

    }

    if(tournoi.status === "finished"){

      return res.status(409).send(
        tr(
          req,
          "Le tournoi est déjà terminé",
          "The tournament is already finished"
        )
      );

    }

    const participants = await all(
      `
      SELECT *
      FROM participants
      WHERE tournament_id=?
      ORDER BY id
      `,
      [tournamentId]
    );

    const nombreParticipants =
      participants.length;

    const nombreMaximum =
      Number(tournoi.max_teams || 0);

    if(
      nombreParticipants !==
      nombreMaximum
    ){

      return res.status(400).send(
        tr(
          req,
          `Le tournoi n'est pas complet. Il faut ${nombreMaximum} participants. Actuellement : ${nombreParticipants}/${nombreMaximum}.`,
          `The tournament is not full. ${nombreMaximum} participants are required. Currently: ${nombreParticipants}/${nombreMaximum}.`
        )
      );

    }

    const dejaMatchs = await get(
      `
      SELECT COUNT(*) AS total
      FROM matches
      WHERE tournament_id=?
      `,
      [tournamentId]
    );

    if(
      Number(dejaMatchs.total || 0) > 0
    ){

      return res.status(409).send(
        tr(
          req,
          "Tirage déjà généré",
          "Draw already generated"
        )
      );

    }

    /*
      Toutes les vérifications sont terminées.
      On peut maintenant commencer la transaction.
    */
    await run("BEGIN TRANSACTION");

    try{

      
      /*
        TOURNOI AVEC POULES
      */
      if(tournoi.type !== "poule"){

  return res.status(400).send(
    tr(
      req,
      "Cette route est réservée aux tournois avec poules",
      "This route is only available for group-stage tournaments"
    )
  );

}

      const groupes =
        genererGroupesAuto(
          participants
        );

      let matchOrder = 1;

      for(
        let indexGroupe = 0;
        indexGroupe < groupes.length;
        indexGroupe++
      ){

        const groupe =
          groupes[indexGroupe];

        const groupName =
          String.fromCharCode(
            65 + indexGroupe
          );

        for(const participant of groupe){

          await run(
            `
            UPDATE participants
            SET group_name=?
            WHERE id=?
              AND tournament_id=?
            `,
            [
              groupName,
              participant.id,
              tournamentId
            ]
          );

        }

        const journees =
          genererMatchsPoule(
            groupe
          );

        for(const journee of journees){

          for(const match of journee){

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
                tournamentId,
                "POULE",
                groupName,
                matchOrder++,
                match[0].id,
                match[1].id
              ]
            );

          }

        }

      }

      await run(
        `
        UPDATE tournaments
        SET status='started'
        WHERE id=?
        `,
        [tournamentId]
      );

      await run("COMMIT");

      /*
        Les notifications sont envoyées après
        la validation de la transaction.
      */
      for(const participant of participants){

        if(!participant.user_id){
          continue;
        }

        await notifierUtilisateur(
          participant.user_id,
          "🏆 Début du tournoi",
          `Le tournoi "${tournoi.name}" vient de commencer.`,
          `tournament:${tournamentId}`
        );

      }

      return res.send(
        tr(
          req,
          "Tirage poules généré",
          "Group-stage draw generated"
        )
      );

    }catch(errorTransaction){

      try{
        await run("ROLLBACK");
      }catch(errorRollback){
        console.error(
          "Erreur ROLLBACK tirage :",
          errorRollback
        );
      }

      throw errorTransaction;

    }

  }catch(error){

    console.error(
      "Erreur tirage :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur pendant la génération du tirage",
        "Error while generating the draw"
      )
    );

  }

});

app.post(
  "/generer-phase-finale",
  async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const tournamentId =
      Number(req.body.tournament_id);

    if(
      !Number.isInteger(tournamentId) ||
      tournamentId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Tournoi obligatoire ou invalide",
          "Tournament is required or invalid"
        )
      );

    }

    const ownerCheck =
      await verifierProprietaireTournoi(
        req,
        tournamentId
      );

    if(!ownerCheck.ok){

      return res.status(403).send(
        ownerCheck.message
      );

    }

    const tournoi =
      ownerCheck.tournoi;

    if(tournoi.type !== "poule"){

      return res.status(400).send(
        tr(
          req,
          "Cette action est réservée aux tournois avec poules",
          "This action is only available for group-stage tournaments"
        )
      );

    }

    if(tournoi.status === "finished"){

      return res.status(409).send(
        tr(
          req,
          "Le tournoi est déjà terminé",
          "The tournament is already finished"
        )
      );

    }

    const poulesTerminees =
      await tousMatchsPoulesTermines(
        tournamentId
      );

    if(!poulesTerminees){

      return res.status(409).send(
        tr(
          req,
          "Tous les matchs de poules doivent être terminés avant la phase finale",
          "All group-stage matches must be completed before the knockout stage"
        )
      );

    }

    const qualifies =
      await recupererQualifiesPoules(
        tournamentId
      );

      const groupesDebug =
  await classementPoules(
    tournamentId
  );

console.log(
  "NOMBRE GROUPES =",
  Object.keys(groupesDebug)
    .filter(g => g !== "Sans groupe")
    .length
);

console.log(
  "NOMBRE QUALIFIÉS =",
  qualifies.length
);

    if(
      !Array.isArray(qualifies) ||
      qualifies.length < 2
    ){

      return res.status(400).send(
        tr(
          req,
          "Impossible de déterminer les équipes qualifiées",
          "Unable to determine the qualified teams"
        )
      );

    }

    await run("BEGIN TRANSACTION");

    try{

      const resultat =
        await creerPremierTourPhaseFinale(
          tournamentId,
          qualifies
        );

      await run("COMMIT");

      if(!resultat.created){

        return res.status(409).send(
          tr(
            req,
            "La phase finale est déjà générée",
            "The knockout stage has already been generated"
          )
        );

      }

      return res.send(
        tr(
          req,
          `Phase finale générée : ${resultat.round}`,
          `Knockout stage generated: ${resultat.round}`
        )
      );

    }catch(errorTransaction){

      try{
        await run("ROLLBACK");
      }catch(errorRollback){
        console.error(
          "Erreur ROLLBACK phase finale :",
          errorRollback
        );
      }

      throw errorTransaction;

    }

  }catch(error){

    console.error(
      "Erreur génération phase finale :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur pendant la génération de la phase finale",
        "Failed to generate the knockout stage"
      )
    );

  }

});

app.post(
  "/generer-tour-suivant",
  async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const tournamentId =
      Number(req.body.tournament_id);

    const round =
      String(req.body.round || "")
        .trim()
        .toUpperCase();

    if(
      !Number.isInteger(tournamentId) ||
      tournamentId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Tournoi obligatoire ou invalide",
          "Tournament is required or invalid"
        )
      );

    }

    const roundsAutorises = [
      "16ES",
      "8ES",
      "QUARTS",
      "DEMIS"
    ];

    if(!roundsAutorises.includes(round)){

      return res.status(400).send(
        tr(
          req,
          "Tour invalide",
          "Invalid round"
        )
      );

    }

    const ownerCheck =
      await verifierProprietaireTournoi(
        req,
        tournamentId
      );

    if(!ownerCheck.ok){

      return res.status(403).send(
        ownerCheck.message
      );

    }

    const tournoi =
      ownerCheck.tournoi;

    if(tournoi.status === "finished"){

      return res.status(409).send(
        tr(
          req,
          "Le tournoi est déjà terminé",
          "The tournament is already finished"
        )
      );

    }

    await run("BEGIN TRANSACTION");

    try{

      const resultat =
        await genererTourSuivantPhaseFinale(
          tournamentId,
          round
        );

      if(resultat.incomplete){

        await run("ROLLBACK");

        return res.status(409).send(
          tr(
            req,
            "Tous les matchs de ce tour doivent être terminés",
            "All matches in this round must be completed"
          )
        );

      }

      if(resultat.penaltiesMissing){

        await run("ROLLBACK");

        return res.status(409).send(
          tr(
            req,
            "Des tirs au but sont nécessaires pour départager un duel",
            "Penalty shootout scores are required to decide a tie"
          )
        );

      }

      if(resultat.alreadyCreated){

        await run("ROLLBACK");

        return res.status(409).send(
          tr(
            req,
            "Le tour suivant est déjà généré",
            "The next round has already been generated"
          )
        );

      }

      if(resultat.finished){

        await run("ROLLBACK");

        return res.status(400).send(
          tr(
            req,
            "Aucun tour suivant après la finale",
            "There is no round after the final"
          )
        );

      }

      await run("COMMIT");

      return res.send(
        tr(
          req,
          `Tour suivant généré : ${resultat.round}`,
          `Next round generated: ${resultat.round}`
        )
      );

    }catch(errorTransaction){

      try{
        await run("ROLLBACK");
      }catch(errorRollback){

        console.error(
          "Erreur ROLLBACK tour suivant :",
          errorRollback
        );

      }

      throw errorTransaction;

    }

  }catch(error){

    console.error(
      "Erreur génération tour suivant :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur pendant la génération du tour suivant",
        "Failed to generate the next round"
      )
    );

  }

});


app.post(
  "/send-reset-code",
  emailCodeLimiter,
  async (req,res)=>{

    const reponseGenerique =
      tr(
        req,
        "Si un compte correspond à cette adresse, un code sera envoyé.",
        "If an account matches this address, a code will be sent."
      );

    try{

      const email =
        String(req.body.email || "")
          .trim()
          .toLowerCase();

      if(!email){

        return res.status(400).send(
          tr(
            req,
            "Email obligatoire",
            "Email is required"
          )
        );

      }

      if(
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ){

        return res.status(400).send(
          tr(
            req,
            "Adresse email invalide",
            "Invalid email address"
          )
        );

      }

      const user = await get(
        `
        SELECT id
        FROM users
        WHERE email=?
        `,
        [email]
      );

      /*
        Même réponse si le compte n'existe pas,
        afin de ne pas révéler les utilisateurs.
      */
      if(!user){

        return res.send(
          reponseGenerique
        );

      }

      await run(
        `
        DELETE FROM email_codes
        WHERE email=?
           OR datetime(created_at)
              < datetime('now','-1 day')
        `,
        [email]
      );

      const code =
        Math.floor(
          100000 +
          Math.random() * 900000
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
          email,
          code
        ]
      );

      await transporter.sendMail({
        from:process.env.MAIL_USER,
        to:email,
        subject:
          "Réinitialisation du mot de passe SNUGAME",
        text:
          "Votre code de réinitialisation SNUGAME est : " +
          code +
          "\n\nCe code expire dans 15 minutes."
      });

      return res.send(
        reponseGenerique
      );

    }catch(error){

      console.error(
        "Erreur envoi code reset :",
        error
      );

      /*
        Réponse générique pour ne pas révéler
        l'existence ou non du compte.
      */
      return res.send(
        reponseGenerique
      );

    }

  }
);

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
      return res.send(
  tr(req,
    "Lien inscription invalide",
    "Invalid registration link")
);
    }

    const count = await get(
      `
      SELECT COUNT(*) AS total
      FROM participants
      WHERE tournament_id=?
      `,
      [tournoi.id]
    );

    if(tournoi.status === "started" || tournoi.status === "finished"){
     return res.send(
  tr(req,
    "Les inscriptions sont fermées. Le tirage a commencé.",
    "Registration is closed. The draw has already started.")
);
    }

    if(count.total >= tournoi.max_teams){
      return res.send(
  tr(req,
    "Tournoi complet. Inscriptions fermées.",
    "Tournament is full. Registrations are closed.")
);
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

  msg.textContent =
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

    msg.textContent =
      text;

    return text;

  }catch(e){

    msg.textContent =
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

  const result = await post("/join-tournament", payload);

  if(result.startsWith("dashboardUrl:")){

    window.location.href =
      result.replace("dashboardUrl:","");

    return;

  }

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
      return res.send(
  tr(req,
    "Tous les champs sont obligatoires",
    "All fields are required")
);
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
      return res.send(
  tr(req,"Tournoi introuvable","Tournament not found")
);
    }

    if(tournoi.status === "started" || tournoi.status === "finished"){
    return res.send(
  tr(req,
    "Les inscriptions sont fermées. Le tirage a commencé.",
    "Registration is closed. The draw has already started.")
);
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
      return res.send(
  tr(req,
    "Tournoi complet. Le lien est fermé.",
    "Tournament is full. Registration link is closed.")
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
      return res.send(
  tr(req,
    "Code invalide",
    "Invalid verification code")
);
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

  const autoUsername =
    "user" + created.lastID;

  await run(
    `
    UPDATE users
    SET username=?
    WHERE id=?
    `,
    [
      autoUsername,
      created.lastID
    ]
  );

  user = {
    id:created.lastID,
    name:name.trim(),
    email:cleanEmail,
    username:autoUsername
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
      return res.send(
  tr(req,
    "Tu es déjà inscrit à ce tournoi",
    "You are already registered for this tournament")
);
    }

    const result = await run(
      `
      INSERT INTO participants(
  tournament_id,
  prenom,
  email,
  user_id,
  username,
  telephone,
  numero_serie,
  club_logo,
  preuve
)
VALUES(?,?,?,?,?,?,?,?,?)
      `,
      [
  tournoi.id,
  name.trim(),
  cleanEmail,
  user.id,
  user.username || name.trim(),
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

    res.send(
  "dashboardUrl:/app"
);

  }catch(e){

    console.log(e);
    
   res.send(
  tr(req,
    "Erreur inscription automatique tournoi : ",
    "Tournament registration failed: "
  ) + e.message
);
  }

});
app.post("/admin-ban-user", async (req,res)=>{

  try{

    if(!isAdmin(req)){

      return res
        .status(403)
        .send("Accès admin refusé");

    }

    const userId =
      Number(req.body.user_id);

    if(
      !Number.isInteger(userId) ||
      userId <= 0
    ){

      return res
        .status(400)
        .send("Utilisateur invalide");

    }

    const user = await get(
      `
      SELECT id
      FROM users
      WHERE id=?
      `,
      [userId]
    );

    if(!user){

      return res
        .status(404)
        .send("Utilisateur introuvable");

    }

    await run(
      `
      UPDATE users
      SET banned=1
      WHERE id=?
      `,
      [userId]
    );

    /*
      Supprime les sessions actives de cet
      utilisateur si ta table de sessions
      contient les données sous forme JSON.
    */

    return res.redirect("/admin-users");

  }catch(error){

    console.error(
      "Erreur bannissement :",
      error
    );

    return res
      .status(500)
      .send("Erreur bannissement");

  }

});
app.get("/admin-users", async (req,res)=>{

  try{

    if(!isAdmin(req)){
      return res.send("Accès admin refusé");
    }

    const users = await all(
      `
      SELECT
        id,
        name,
        email,
        abonnement,
        banned
      FROM users
      ORDER BY id DESC
      `
    );

let html = `
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Admin Utilisateurs</title>
</head>
<body style="background:#07111f;color:white;font-family:Arial;padding:20px;">

<h1>Admin Utilisateurs SNUGAME</h1>

<a href="/admin-payments" style="color:#60a5fa;">
Retour paiements
</a>
`;

users.forEach(u=>{

  html += `
<div style="background:#0f172a;border:1px solid #334155;border-radius:15px;padding:15px;margin:12px 0;">
  <h2>${escapeHtml(u.name || "Sans nom")}</h2>
  <p>ID : ${u.id}</p>
  <p>Email : ${escapeHtml(u.email || "")}</p>
  <p>Abonnement : ${u.abonnement === 1 ? "Premium" : "Gratuit"}</p>
  <p>Status : ${u.banned === 1 ? "🚫 Banni" : "✅ Actif"}</p>

  ${
    u.banned === 1
    ? `
      <form method="POST" action="/admin-unban-user">
        <input type="hidden" name="user_id" value="${u.id}">
        <button>Débannir</button>
      </form>
    `
    : `
      <form method="POST" action="/admin-ban-user">
        <input type="hidden" name="user_id" value="${u.id}">
        <button style="background:#ef4444;color:white;">Bannir</button>
      </form>
    `
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
    res.send("Erreur admin utilisateurs");

  }

});

app.post("/admin-unban-user", async (req,res)=>{

  try{

    if(!isAdmin(req)){

      return res
        .status(403)
        .send("Accès admin refusé");

    }

    const userId =
      Number(req.body.user_id);

    if(
      !Number.isInteger(userId) ||
      userId <= 0
    ){

      return res
        .status(400)
        .send("Utilisateur invalide");

    }

    const result = await run(
      `
      UPDATE users
      SET banned=0
      WHERE id=?
      `,
      [userId]
    );

    if(result.changes === 0){

      return res
        .status(404)
        .send("Utilisateur introuvable");

    }

    return res.redirect("/admin-users");

  }catch(error){

    console.error(
      "Erreur débannissement :",
      error
    );

    return res
      .status(500)
      .send("Erreur débannissement");

  }

});

app.post(
  "/update-profile-photo",
  async (req,res)=>{

    try{

      if(!connected(req)){

        return res.status(401).send(
          tr(
            req,
            "Connecte-toi",
            "Please log in"
          )
        );

      }

      const photo =
        String(req.body.photo || "")
          .trim();

      if(!photo){

        return res.status(400).send(
          tr(
            req,
            "Photo obligatoire",
            "Profile photo is required"
          )
        );

      }

      if(photo.length > 2000){

        return res.status(400).send(
          tr(
            req,
            "Adresse de photo trop longue",
            "Profile photo URL is too long"
          )
        );

      }

      let photoUrl;

      try{

        photoUrl = new URL(photo);

      }catch{

        return res.status(400).send(
          tr(
            req,
            "Adresse de photo invalide",
            "Invalid profile photo URL"
          )
        );

      }

      const r2PublicUrl =
        String(
          process.env.R2_PUBLIC_URL || ""
        ).replace(/\/+$/,"");

      if(
        !r2PublicUrl ||
        !photo.startsWith(
          r2PublicUrl + "/"
        )
      ){

        return res.status(400).send(
          tr(
            req,
            "La photo doit avoir été envoyée depuis SNUGAME",
            "The photo must have been uploaded through SNUGAME"
          )
        );

      }

      const extension =
        path.extname(
          photoUrl.pathname
        ).toLowerCase();

      const allowedExtensions = [
        ".jpg",
        ".jpeg",
        ".png",
        ".webp"
      ];

      if(
        !allowedExtensions.includes(
          extension
        )
      ){

        return res.status(400).send(
          tr(
            req,
            "Format de photo invalide",
            "Invalid profile photo format"
          )
        );

      }

      await run(
        `
        UPDATE users
        SET profile_photo=?
        WHERE id=?
        `,
        [
          photo,
          req.session.userId
        ]
      );

      return res.send(
        tr(
          req,
          "Photo profil mise à jour",
          "Profile photo updated"
        )
      );

    }catch(error){

      console.error(
        "Erreur photo profil :",
        error
      );

      return res.status(500).send(
        tr(
          req,
          "Erreur photo profil",
          "Failed to update profile photo"
        )
      );

    }

  }
);

app.post("/update-username", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const clean =
      String(req.body.username || "")
        .trim()
        .toLowerCase();

    if(!clean){

      return res.status(400).send(
        tr(
          req,
          "Nom utilisateur obligatoire",
          "Username is required"
        )
      );

    }

    if(
      clean.length < 3 ||
      clean.length > 30
    ){

      return res.status(400).send(
        tr(
          req,
          "Le nom utilisateur doit contenir entre 3 et 30 caractères",
          "Username must contain between 3 and 30 characters"
        )
      );

    }

    if(!/^[a-z0-9._]+$/.test(clean)){

      return res.status(400).send(
        tr(
          req,
          "Utilise seulement lettres, chiffres, point ou _",
          "Use only letters, numbers, dots or underscores"
        )
      );

    }

    if(
      clean.startsWith(".") ||
      clean.endsWith(".") ||
      clean.startsWith("_") ||
      clean.endsWith("_")
    ){

      return res.status(400).send(
        tr(
          req,
          "Le nom utilisateur ne doit pas commencer ou finir par un point ou un _",
          "Username must not start or end with a dot or underscore"
        )
      );

    }

    if(
      clean.includes("..") ||
      clean.includes("__")
    ){

      return res.status(400).send(
        tr(
          req,
          "Les points ou _ ne doivent pas être répétés",
          "Dots or underscores must not be repeated"
        )
      );

    }

    if(containsBadWords(clean)){

      return res.status(400).send(
        tr(
          req,
          "Contenu interdit détecté",
          "Forbidden content detected"
        )
      );

    }

    const user = await get(
      `
      SELECT
        username,
        username_updated_at
      FROM users
      WHERE id=?
      `,
      [req.session.userId]
    );

    if(!user){

      return res.status(404).send(
        tr(
          req,
          "Compte introuvable",
          "Account not found"
        )
      );

    }

    if(user.username === clean){

      return res.status(400).send(
        tr(
          req,
          "Ce nom utilisateur est déjà le tien",
          "This is already your username"
        )
      );

    }

    if(user.username_updated_at){

      const last =
        new Date(user.username_updated_at);

      const diffDays =
        (Date.now() - last.getTime()) /
        (1000 * 60 * 60 * 24);

      if(
        !Number.isNaN(diffDays) &&
        diffDays < 30
      ){

        const joursRestants =
          Math.ceil(30 - diffDays);

        return res.status(429).send(
          `ATTENDRE_30_JOURS:${joursRestants}`
        );

      }

    }

    const exist = await get(
      `
      SELECT id
      FROM users
      WHERE username=?
        AND id<>?
      `,
      [
        clean,
        req.session.userId
      ]
    );

    if(exist){

      return res.status(409).send(
        tr(
          req,
          "Ce nom utilisateur est déjà pris",
          "This username is already taken"
        )
      );

    }

    await run(
      `
      UPDATE users
      SET username=?,
          username_updated_at=?
      WHERE id=?
      `,
      [
        clean,
        new Date().toISOString(),
        req.session.userId
      ]
    );

    return res.send(
      tr(
        req,
        "Nom utilisateur mis à jour ✅",
        "Username updated ✅"
      )
    );

  }catch(error){

    console.error(
      "Erreur nom utilisateur :",
      error
    );

    if(
      error.code ===
      "SQLITE_CONSTRAINT"
    ){

      return res.status(409).send(
        tr(
          req,
          "Ce nom utilisateur est déjà pris",
          "This username is already taken"
        )
      );

    }

    return res.status(500).send(
      tr(
        req,
        "Erreur nom utilisateur",
        "Username update failed"
      )
    );

  }

});


app.get("/search-users", async (req,res)=>{

  try{

    const q =
      (req.query.q || "")
      .trim()
      .toLowerCase();

    if(!q){
      return res.json([]);
    }

    const users = await all(
      `
      SELECT
        id,
        name,
        username,
        profile_photo
      FROM users
      WHERE username LIKE ?
      LIMIT 20
      `,
      [`%${q}%`]
    );

    res.json(users);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});
app.get("/player-profile/:id", async (req,res)=>{

  try{

    const user = await get(
      `
      SELECT
        id,
        name,
        username,
        profile_photo,
        abonnement
      FROM users
      WHERE id=?
      `,
      [req.params.id]
    );

    if(!user){
      return res.json({
        error:"Joueur introuvable"
      });
    }

    const followers = await get(
  `
  SELECT COUNT(*) AS total
  FROM follows
  WHERE following_participant_id=?
  `,
  [user.id]
);

    const following = await get(
  `
  SELECT COUNT(*) AS total
  FROM follows
  WHERE follower_id=?
  `,
  [user.id]
);

    const stats = await get(
      `
      SELECT *
      FROM user_player_stats
      WHERE user_id=?
      ORDER BY season_year DESC
      LIMIT 1
      `,
      [user.id]
    );

    res.json({
      ...user,
      followers:followers.total || 0,
      following:following.total || 0,

      matchs:stats?.matchs || 0,
      victoires:stats?.victoires || 0,
      defaites:stats?.defaites || 0,
      coupes:stats?.coupes || 0,
      nuls:stats?.nuls || 0,
      buts_marques:stats?.buts_marques || 0,
      buts_encaisses:stats?.buts_encaisses || 0,
      niveau:stats?.niveau || 1,
      xp:stats?.xp || 0,
      tournois_participes:stats?.tournois_participes || 0,
      tournois_gagnes:stats?.tournois_gagnes || 0
    });

  }catch(e){

    console.log(e);

    res.json({
      error:"Erreur profil joueur"
    });

  }

});

app.get("/notifications", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).json({
        ok:false,
        message:tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      });

    }

    const rows = await all(
      `
      SELECT
        id,
        message,
        seen,
        created_at
      FROM notifications
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 50
      `,
      [req.session.userId]
    );

    return res.json(rows);

  }catch(error){

    console.error(
      "Erreur chargement notifications :",
      error
    );

    return res.status(500).json({
      ok:false,
      message:tr(
        req,
        "Impossible de charger les notifications",
        "Failed to load notifications"
      )
    });

  }

});

app.post("/delete-highlight", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const highlightId =
      Number(req.body.id);

    if(
      !Number.isInteger(highlightId) ||
      highlightId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Vidéo invalide",
          "Invalid video"
        )
      );

    }

    const highlight = await get(
      `
      SELECT id, user_id
      FROM highlights
      WHERE id=?
      `,
      [highlightId]
    );

    if(!highlight){

      return res.status(404).send(
        tr(
          req,
          "Vidéo introuvable",
          "Video not found"
        )
      );

    }

    if(
      Number(highlight.user_id) !==
      Number(req.session.userId)
    ){

      return res.status(403).send(
        tr(
          req,
          "Tu ne peux supprimer que tes vidéos",
          "You can only delete your own videos"
        )
      );

    }

    await run("BEGIN TRANSACTION");

    try{

      await run(
        `
        DELETE FROM highlight_likes
        WHERE highlight_id=?
        `,
        [highlightId]
      );

      await run(
        `
        DELETE FROM highlight_comments
        WHERE highlight_id=?
        `,
        [highlightId]
      );

      await run(
        `
        DELETE FROM video_favorites
        WHERE highlight_id=?
        `,
        [highlightId]
      );

      await run(
        `
        DELETE FROM highlight_views
        WHERE highlight_id=?
        `,
        [highlightId]
      );

      await run(
        `
        DELETE FROM video_watch_time
        WHERE highlight_id=?
        `,
        [highlightId]
      );

      await run(
        `
        DELETE FROM warnings
        WHERE video_id=?
        `,
        [highlightId]
      );

      await run(
        `
        DELETE FROM highlights
        WHERE id=?
          AND user_id=?
        `,
        [
          highlightId,
          req.session.userId
        ]
      );

      await run("COMMIT");

    }catch(error){

      await run("ROLLBACK");
      throw error;

    }

    return res.send(
      tr(
        req,
        "Vidéo supprimée",
        "Video deleted"
      )
    );

  }catch(error){

    console.error(
      "Erreur suppression vidéo :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur suppression vidéo",
        "Failed to delete video"
      )
    );

  }

});

app.get("/my-videos", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.json([]);
    }

    const videos = await all(
      `
      SELECT
        h.*,
        u.name,
        u.username,
        u.profile_photo
      FROM highlights h
      LEFT JOIN users u
      ON u.id=h.user_id
      WHERE h.user_id=?
      ORDER BY h.id DESC
      `,
      [req.session.userId]
    );

    res.json(videos);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.get("/user-videos/:userId", async (req,res)=>{

  try{

    const videos = await all(
      `
      SELECT *
      FROM highlights
      WHERE user_id=?
      ORDER BY id DESC
      `,
      [req.params.userId]
    );

    res.json(videos);

  }catch(e){
    console.log(e);
    res.json([]);
  }

});

app.post("/fix-old-videos", async (req,res)=>{

  try{

    if(!isAdmin(req)){

      return res
        .status(403)
        .send("Accès admin refusé");

    }

    const userId =
      Number(req.body.user_id);

    if(
      !Number.isInteger(userId) ||
      userId <= 0
    ){

      return res
        .status(400)
        .send(
          "Identifiant utilisateur invalide"
        );

    }

    const user = await get(
      `
      SELECT id
      FROM users
      WHERE id=?
      `,
      [userId]
    );

    if(!user){

      return res
        .status(404)
        .send(
          "Utilisateur introuvable"
        );

    }

    const result = await run(
      `
      UPDATE highlights
      SET user_id=?
      WHERE user_id IS NULL
      `,
      [userId]
    );

    return res.send(
      `${result.changes || 0} anciennes vidéos liées à l'utilisateur`
    );

  }catch(error){

    console.error(
      "Erreur rattachement anciennes vidéos :",
      error
    );

    return res
      .status(500)
      .send(
        "Erreur rattachement anciennes vidéos"
      );

  }

});

app.post("/delete-old-videos", async (req,res)=>{

  try{

    if(!isAdmin(req)){

      return res
        .status(403)
        .send("Accès admin refusé");

    }

    const result = await run(
      `
      DELETE FROM highlights
      WHERE user_id IS NULL
      `
    );

    return res.send(
      `${result.changes || 0} anciennes vidéos supprimées`
    );

  }catch(error){

    console.error(
      "Erreur suppression anciennes vidéos :",
      error
    );

    return res
      .status(500)
      .send(
        "Erreur suppression anciennes vidéos"
      );

  }

});

async function gererTournoiRapideApresScore(match){

  const tournoi = await get(
    `
    SELECT *
    FROM tournaments
    WHERE id=?
    `,
    [match.tournament_id]
  );

  if(
    !tournoi ||
    tournoi.type !== "rapide"
  ){
    return;
  }

  if(match.round === "POULE"){
    return;
  }

  const updatedMatch = await get(
    `
    SELECT *
    FROM matches
    WHERE id=?
    `,
    [match.id]
  );

  if(
    !updatedMatch ||
    Number(updatedMatch.played) !== 1
  ){
    return;
  }

  const duel = await all(
    `
    SELECT *
    FROM matches
    WHERE tournament_id=?
      AND round=?
      AND (
        (
          player1_id=?
          AND player2_id=?
        )
        OR
        (
          player1_id=?
          AND player2_id=?
        )
      )
    ORDER BY id
    `,
    [
      updatedMatch.tournament_id,
      updatedMatch.round,
      updatedMatch.player1_id,
      updatedMatch.player2_id,
      updatedMatch.player2_id,
      updatedMatch.player1_id
    ]
  );

  const aller =
    duel.find(
      m =>
        m.journee === "ALLER" ||
        m.leg === "ALLER"
    );

  const retour =
    duel.find(
      m =>
        m.journee === "RETOUR" ||
        m.leg === "RETOUR"
    );

  if(!aller || !retour){
    return;
  }

  if(
    Number(aller.played) !== 1 ||
    Number(retour.played) !== 1
  ){
    return;
  }

  const player1 =
    Number(aller.player1_id);

  const player2 =
    Number(aller.player2_id);

  function scoreDuJoueur(matchRow, playerId){

    if(
      Number(matchRow.player1_id) ===
      Number(playerId)
    ){
      return Number(matchRow.score1 || 0);
    }

    if(
      Number(matchRow.player2_id) ===
      Number(playerId)
    ){
      return Number(matchRow.score2 || 0);
    }

    return 0;

  }

  const totalPlayer1 =
    scoreDuJoueur(aller, player1) +
    scoreDuJoueur(retour, player1);

  const totalPlayer2 =
    scoreDuJoueur(aller, player2) +
    scoreDuJoueur(retour, player2);

  let winner = null;

  if(totalPlayer1 > totalPlayer2){

    winner = player1;

  }else if(totalPlayer2 > totalPlayer1){

    winner = player2;

}else{

  const penalty1 =
    retour.penalty1 === null ||
    retour.penalty1 === undefined
      ? null
      : Number(retour.penalty1);

  const penalty2 =
    retour.penalty2 === null ||
    retour.penalty2 === undefined
      ? null
      : Number(retour.penalty2);

  if(
    penalty1 === null ||
    penalty2 === null
  ){

    return;

  }

  if(penalty1 > penalty2){

    winner = Number(
      retour.player1_id
    );

  }else if(penalty2 > penalty1){

    winner = Number(
      retour.player2_id
    );

  }else{

    return;

  }

}
  const sourceOrder =
  Math.ceil(
    Number(
      aller.match_order ||
      retour.match_order ||
      1
    ) / 2
  );

await qualifierJoueurRapide(
  updatedMatch.tournament_id,
  updatedMatch.round,
  winner,
  sourceOrder
);

}


app.get("/classement-rapide-32/:id", async (req,res)=>{

  try{

    const participants = await all(
      `
      SELECT
        p.id,
        p.prenom AS equipe,

        COUNT(m.id) AS j,

        SUM(
          CASE
            WHEN m.winner_id = p.id THEN 1
            ELSE 0
          END
        ) AS g,

        SUM(
          CASE
            WHEN m.played = 1
            AND m.score1 = m.score2 THEN 1
            ELSE 0
          END
        ) AS n,

        SUM(
          CASE
            WHEN m.loser_id = p.id THEN 1
            ELSE 0
          END
        ) AS p_defaites,

        SUM(
          CASE
            WHEN m.player1_id = p.id THEN m.score1
            WHEN m.player2_id = p.id THEN m.score2
            ELSE 0
          END
        ) AS bp,

        SUM(
          CASE
            WHEN m.player1_id = p.id THEN m.score2
            WHEN m.player2_id = p.id THEN m.score1
            ELSE 0
          END
        ) AS bc

      FROM participants p

      LEFT JOIN matches m
        ON m.tournament_id = p.tournament_id
        AND m.played = 1
        AND (
          m.player1_id = p.id
          OR m.player2_id = p.id
        )

      WHERE p.tournament_id=?

      GROUP BY p.id

      ORDER BY
        (bp - bc) DESC,
        bp DESC,
        p.id ASC
      `,
      [req.params.id]
    );

    res.json(
      participants.map((p,index)=>{

        const j = Number(p.j || 0);
        const g = Number(p.g || 0);
        const n = Number(p.n || 0);
        const d = Number(p.p_defaites || 0);
        const bp = Number(p.bp || 0);
        const bc = Number(p.bc || 0);

        const pts =
          g * 3 + n;

        const maxPts =
          j * 3;

        const percent =
          maxPts > 0
          ? Math.round((pts / maxPts) * 100)
          : 0;

        const pe =
          maxPts - pts;

        return {
          numero:index + 1,
          equipe:p.equipe,
          pts,
          j,
          g,
          n,
          p:d,
          bp,
          bc,
          dif:bp - bc,
          percent,
          pe
        };

      })
    );

  }catch(e){

    console.log(e);
    res.json([]);

  }

});


function getNextRoundRapide(round){

  if(round === "16ES") return "8ES";
  if(round === "8ES") return "QUARTS";
  if(round === "QUARTS") return "DEMIS";
  if(round === "DEMIS") return "FINALE";

  return null;

}

async function qualifierJoueurRapide(
  tournamentId,
  round,
  winnerId,
  sourceOrder
){

  if(!winnerId){
    return;
  }

  const nextRound =
    getNextRoundRapide(round);

  if(!nextRound){

  const tournoi = await get(
    `
    SELECT name
    FROM tournaments
    WHERE id=?
    `,
    [tournamentId]
  );

  await run(
    `
    UPDATE tournaments
    SET champion_id=?,
        status='finished'
    WHERE id=?
    `,
    [
      winnerId,
      tournamentId
    ]
  );

  await compterTournoiTermine(
    tournamentId
  );

  await recompenserChampion(
    tournamentId,
    winnerId
  );

  const champion = await get(
    `
    SELECT user_id
    FROM participants
    WHERE id=?
    `,
    [winnerId]
  );

  if(
    champion &&
    champion.user_id
  ){

    await notifierUtilisateur(
      champion.user_id,
      "👑 Félicitations !",
      `Tu as remporté le tournoi "${tournoi?.name || "Tournoi"}". Bravo Champion ! 🏆`,
      `tournament:${tournamentId}`
    );

  }

  return;
}
await run(
  `
  INSERT OR IGNORE INTO rapid_qualifiers(
    tournament_id,
    round,
    player_id,
    source_order
  )
  VALUES(?,?,?,?)
  `,
  [
    tournamentId,
    round,
    winnerId,
    Number(sourceOrder || 0)
  ]
);

const qualifies = await all(
  `
  SELECT
    player_id,
    MIN(source_order) AS source_order
  FROM rapid_qualifiers
  WHERE tournament_id=?
    AND round=?
  GROUP BY player_id
  ORDER BY
    MIN(source_order) ASC,
    player_id ASC
  `,
  [
    tournamentId,
    round
  ]
);
const qualifiesParOrdre =
  new Map();

for(const qualifie of qualifies){

  qualifiesParOrdre.set(
    Number(qualifie.source_order),
    Number(qualifie.player_id)
  );

}

const ordreMaximum =
  Math.max(
    0,
    ...qualifies.map(
      q => Number(q.source_order || 0)
    )
  );

for(
  let ordreSource = 1;
  ordreSource <= ordreMaximum;
  ordreSource += 2
){

  const p1 =
    qualifiesParOrdre.get(
      ordreSource
    );

  const p2 =
    qualifiesParOrdre.get(
      ordreSource + 1
    );

  /*
    On attend que les deux duels voisins
    soient terminés.
  */
  if(!p1 || !p2){
    continue;
  }

  const ordreDuelSuivant =
    Math.ceil(
      ordreSource / 2
    );

  const alreadyPair = await get(
    `
    SELECT id
    FROM matches
    WHERE tournament_id=?
      AND round=?
      AND (
        (
          player1_id=?
          AND player2_id=?
        )
        OR
        (
          player1_id=?
          AND player2_id=?
        )
      )
    LIMIT 1
    `,
    [
      tournamentId,
      nextRound,
      p1,
      p2,
      p2,
      p1
    ]
  );

  if(alreadyPair){
    continue;
  }

  const matchOrderAller =
    ordreDuelSuivant * 2 - 1;

  const matchOrderRetour =
    ordreDuelSuivant * 2;

  await run(
    `
    INSERT INTO matches(
      tournament_id,
      round,
      match_order,
      journee,
      player1_id,
      player2_id
    )
    VALUES(?,?,?,?,?,?)
    `,
    [
      tournamentId,
      nextRound,
      matchOrderAller,
      "ALLER",
      p1,
      p2
    ]
  );

  await run(
    `
    INSERT INTO matches(
      tournament_id,
      round,
      match_order,
      journee,
      player1_id,
      player2_id
    )
    VALUES(?,?,?,?,?,?)
    `,
    [
      tournamentId,
      nextRound,
      matchOrderRetour,
      "RETOUR",
      p1,
      p2
    ]
  );

}

}


app.post("/update-name", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi d'abord",
          "Please log in first"
        )
      );

    }

    const name =
      String(req.body.name || "")
        .trim();

    if(!name){

      return res.status(400).send(
        tr(
          req,
          "Nom obligatoire",
          "Name is required"
        )
      );

    }

    if(
      name.length < 2 ||
      name.length > 50
    ){

      return res.status(400).send(
        tr(
          req,
          "Le nom doit contenir entre 2 et 50 caractères",
          "The name must contain between 2 and 50 characters"
        )
      );

    }

    if(containsBadWords(name)){

      return res.status(400).send(
        tr(
          req,
          "Contenu interdit détecté",
          "Forbidden content detected"
        )
      );

    }

    await run(
      `
      UPDATE users
      SET name=?
      WHERE id=?
      `,
      [
        name,
        req.session.userId
      ]
    );

    return res.send(
      tr(
        req,
        "Nom modifié",
        "Name updated"
      )
    );

  }catch(error){

    console.error(
      "Erreur modification nom :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur modification du nom",
        "Failed to update name"
      )
    );

  }

});

app.post(
  "/change-password",
  loginLimiter,
  async (req,res)=>{

    try{

      if(!connected(req)){

        return res.status(401).send(
          tr(
            req,
            "Connecte-toi d'abord",
            "Please log in first"
          )
        );

      }

      const oldPassword =
        String(req.body.oldPassword || "");

      const newPassword =
        String(req.body.newPassword || "");

      if(!oldPassword || !newPassword){

        return res.status(400).send(
          tr(
            req,
            "Tous les champs sont obligatoires",
            "All fields are required"
          )
        );

      }

      if(newPassword.length < 8){

        return res.status(400).send(
          tr(
            req,
            "Mot de passe minimum 8 caractères",
            "Password must be at least 8 characters long"
          )
        );

      }

      if(newPassword.length > 200){

        return res.status(400).send(
          tr(
            req,
            "Mot de passe trop long",
            "Password is too long"
          )
        );

      }

      const user = await get(
        `
        SELECT id, password
        FROM users
        WHERE id=?
        `,
        [req.session.userId]
      );

      if(!user){

        return res.status(404).send(
          tr(
            req,
            "Compte introuvable",
            "Account not found"
          )
        );

      }

      const oldPasswordValid =
        await bcrypt.compare(
          oldPassword,
          user.password
        );

      if(!oldPasswordValid){

        return res.status(400).send(
          tr(
            req,
            "Ancien mot de passe incorrect",
            "Incorrect current password"
          )
        );

      }

      const samePassword =
        await bcrypt.compare(
          newPassword,
          user.password
        );

      if(samePassword){

        return res.status(400).send(
          tr(
            req,
            "Le nouveau mot de passe doit être différent de l'ancien",
            "The new password must be different from the current password"
          )
        );

      }

      const hash =
        await bcrypt.hash(
          newPassword,
          12
        );

      await run(
        `
        UPDATE users
        SET password=?
        WHERE id=?
        `,
        [
          hash,
          user.id
        ]
      );

      return res.send(
        tr(
          req,
          "Mot de passe changé",
          "Password changed"
        )
      );

    }catch(error){

      console.error(
        "Erreur changement mot de passe :",
        error
      );

      return res.status(500).send(
        tr(
          req,
          "Erreur changement de mot de passe",
          "Password change failed"
        )
      );

    }

  }
);

app.post(
  "/send-old-email-code",
  emailCodeLimiter,
  async (req,res)=>{

    try{

      if(!connected(req)){

        return res.status(401).send(
          tr(
            req,
            "Connecte-toi d'abord",
            "Please log in first"
          )
        );

      }

      const user = await get(
        `
        SELECT email
        FROM users
        WHERE id=?
        `,
        [req.session.userId]
      );

      if(!user){

        return res.status(404).send(
          tr(
            req,
            "Compte introuvable",
            "Account not found"
          )
        );

      }

      await run(
        `
        DELETE FROM email_codes
        WHERE email=?
           OR datetime(created_at)
              < datetime('now','-1 day')
        `,
        [user.email]
      );

      const code =
        Math.floor(
          100000 +
          Math.random() * 900000
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
          user.email,
          code
        ]
      );

      await transporter.sendMail({
        from:process.env.MAIL_USER,
        to:user.email,
        subject:
          "Code de vérification email SNUGAME",
        text:
          "Votre code est : " +
          code +
          "\n\nCe code expire dans 15 minutes."
      });

      return res.send(
        tr(
          req,
          "Code envoyé à ton email actuel",
          "Code sent to your current email"
        )
      );

    }catch(error){

      console.error(
        "Erreur envoi code ancien email :",
        error
      );

      return res.status(500).send(
        tr(
          req,
          "Erreur envoi code ancien email",
          "Failed to send code to current email"
        )
      );

    }

  }
);

app.post("/verify-old-email-code", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi d'abord");
    }

    const { code } = req.body;

    if(!code){
      return res.send("Code obligatoire");
    }

    const user = await get(
      `
      SELECT email
      FROM users
      WHERE id=?
      `,
      [req.session.userId]
    );

    if(!user){
      return res.send("Compte introuvable");
    }

    const verification = await get(
  `
  SELECT id
  FROM email_codes
  WHERE email=?
    AND code=?
    AND datetime(created_at)
        >= datetime('now','-15 minutes')
  ORDER BY id DESC
  LIMIT 1
  `,
  [
    user.email,
    String(code).trim()
  ]
);

    if(!verification){

  return res.status(400).send(
    tr(
      req,
      "Code incorrect ou expiré",
      "Invalid or expired code"
    )
  );

}

return res.send(
  tr(
    req,
    "Code valide",
    "Valid code"
  )
);

}catch(error){

  console.error(
    "Erreur vérification ancien email :",
    error
  );

  return res.status(500).send(
    tr(
      req,
      "Erreur vérification du code",
      "Code verification failed"
    )
  );

}

});

app.post(
  "/send-new-email-code",
  emailCodeLimiter,
  async (req,res)=>{

    try{

      if(!connected(req)){

        return res.status(401).send(
          tr(
            req,
            "Connecte-toi d'abord",
            "Please log in first"
          )
        );

      }

      const cleanEmail =
        String(req.body.email || "")
          .trim()
          .toLowerCase();

      if(!cleanEmail){

        return res.status(400).send(
          tr(
            req,
            "Nouvel email obligatoire",
            "New email is required"
          )
        );

      }

      if(
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          cleanEmail
        )
      ){

        return res.status(400).send(
          tr(
            req,
            "Adresse email invalide",
            "Invalid email address"
          )
        );

      }

      const currentUser = await get(
        `
        SELECT email
        FROM users
        WHERE id=?
        `,
        [req.session.userId]
      );

      if(!currentUser){

        return res.status(404).send(
          tr(
            req,
            "Compte introuvable",
            "Account not found"
          )
        );

      }

      if(
        currentUser.email.toLowerCase() ===
        cleanEmail
      ){

        return res.status(400).send(
          tr(
            req,
            "Cette adresse est déjà ton email actuel",
            "This is already your current email"
          )
        );

      }

      const existing = await get(
        `
        SELECT id
        FROM users
        WHERE email=?
        `,
        [cleanEmail]
      );

      if(existing){

        return res.status(409).send(
          tr(
            req,
            "Email déjà utilisé",
            "Email already used"
          )
        );

      }

      await run(
        `
        DELETE FROM email_codes
        WHERE email=?
           OR datetime(created_at)
              < datetime('now','-1 day')
        `,
        [cleanEmail]
      );

      const code =
        Math.floor(
          100000 +
          Math.random() * 900000
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
        subject:
          "Code nouvel email SNUGAME",
        text:
          "Votre code est : " +
          code +
          "\n\nCe code expire dans 15 minutes."
      });

      return res.send(
        tr(
          req,
          "Code envoyé au nouvel email",
          "Code sent to the new email"
        )
      );

    }catch(error){

      console.error(
        "Erreur envoi code nouvel email :",
        error
      );

      return res.status(500).send(
        tr(
          req,
          "Erreur envoi code nouvel email",
          "Failed to send code to new email"
        )
      );

    }

  }
);

app.post(
  "/confirm-new-email",
  emailCodeLimiter,
  async (req,res)=>{

    try{

      if(!connected(req)){

        return res.status(401).send(
          tr(
            req,
            "Connecte-toi d'abord",
            "Please log in first"
          )
        );

      }

      const cleanEmail =
        String(req.body.email || "")
          .trim()
          .toLowerCase();

      const code =
        String(req.body.code || "")
          .trim();

      if(!cleanEmail || !code){

        return res.status(400).send(
          tr(
            req,
            "Email et code obligatoires",
            "Email and code are required"
          )
        );

      }

      const verification = await get(
        `
        SELECT id
        FROM email_codes
        WHERE email=?
          AND code=?
          AND datetime(created_at)
              >= datetime('now','-15 minutes')
        ORDER BY id DESC
        LIMIT 1
        `,
        [
          cleanEmail,
          code
        ]
      );

      if(!verification){

        return res.status(400).send(
          tr(
            req,
            "Code incorrect ou expiré",
            "Invalid or expired code"
          )
        );

      }

      const existing = await get(
        `
        SELECT id
        FROM users
        WHERE email=?
          AND id<>?
        `,
        [
          cleanEmail,
          req.session.userId
        ]
      );

      if(existing){

        return res.status(409).send(
          tr(
            req,
            "Email déjà utilisé",
            "Email already used"
          )
        );

      }

      await run("BEGIN TRANSACTION");

      try{

        await run(
          `
          UPDATE users
          SET email=?
          WHERE id=?
          `,
          [
            cleanEmail,
            req.session.userId
          ]
        );

        await run(
          `
          DELETE FROM email_codes
          WHERE email=?
          `,
          [cleanEmail]
        );

        await run("COMMIT");

      }catch(error){

        await run("ROLLBACK");
        throw error;

      }

      return res.send(
        tr(
          req,
          "Nouvelle adresse enregistrée",
          "New email address saved"
        )
      );

    }catch(error){

      console.error(
        "Erreur changement email :",
        error
      );

      return res.status(500).send(
        tr(
          req,
          "Erreur changement email",
          "Failed to change email"
        )
      );

    }

  }
);

app.get("/my-player-stats", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.json(null);
    }

    await assurerStatsJoueur(req.session.userId);

    const currentYear =
      new Date().getFullYear();

    const stats = await get(
      `
      SELECT *
      FROM user_player_stats
      WHERE user_id=?
      AND season_year=?
      `,
      [
        req.session.userId,
        currentYear
      ]
    );

    res.json(
      stats || {
        matchs:0,
        victoires:0,
        defaites:0,
        nuls:0,
        buts_marques:0,
        buts_encaisses:0,
        xp:0,
        niveau:1,
        coupes:0
      }
    );

  }catch(e){

    console.log(e);

    res.json(null);

  }

});
app.get("/my-trophies", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.json([]);
    }

    const trophies = await all(
      `
      SELECT *
      FROM user_trophies
      WHERE user_id=?
      ORDER BY id DESC
      `,
      [req.session.userId]
    );

    res.json(trophies);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});
app.get("/my-social-stats", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.json({
        followers:0,
        following:0,
        likes:0
      });
    }

    const followers = await get(
      `
      SELECT COUNT(*) AS total
      FROM followers
      WHERE following_id=?
      `,
      [req.session.userId]
    );

    const following = await get(
      `
      SELECT COUNT(*) AS total
      FROM followers
      WHERE follower_id=?
      `,
      [req.session.userId]
    );

    const likes = await get(
      `
      SELECT COALESCE(SUM(likes),0) AS total
      FROM highlights
      WHERE user_id=?
      `,
      [req.session.userId]
    );

    res.json({
      followers: followers?.total || 0,
      following: following?.total || 0,
      likes: likes?.total || 0
    });

  }catch(e){

    console.log(e);

    res.json({
      followers:0,
      following:0,
      likes:0
    });

  }

});

app.get("/my-profile-videos", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.json([]);
    }

    const videos = await all(
      `
      SELECT
        h.*,

        CASE
          WHEN vf.id IS NULL THEN 0
          ELSE 1
        END AS favorited,

        (
          SELECT COUNT(*)
          FROM video_favorites vf2
          WHERE vf2.highlight_id = h.id
        ) AS favorites,

        (
          SELECT COUNT(*)
          FROM highlight_comments hc
          WHERE hc.highlight_id = h.id
        ) AS comments

      FROM highlights h

      LEFT JOIN video_favorites vf
        ON vf.highlight_id = h.id
        AND vf.user_id = ?

      WHERE h.user_id=?

      ORDER BY h.id DESC
      `,
      [
        req.session.userId,
        req.session.userId
      ]
    );

    res.json(videos);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.post("/reset-password", loginLimiter, async (req,res)=>{

  try{

    const email =
      String(req.body.email || "")
        .trim()
        .toLowerCase();

    const code =
      String(req.body.code || "")
        .trim();

    const password =
      String(req.body.password || "");

    if(!email || !code || !password){

      return res.status(400).send(
        tr(
          req,
          "Tous les champs sont obligatoires",
          "All fields are required"
        )
      );

    }

    if(password.length < 8){

      return res.status(400).send(
        tr(
          req,
          "Mot de passe minimum 8 caractères",
          "Password must contain at least 8 characters"
        )
      );

    }

    const user = await get(
      `
      SELECT id
      FROM users
      WHERE email=?
      `,
      [email]
    );

    if(!user){

      return res.status(404).send(
        tr(
          req,
          "Email introuvable",
          "Email not found"
        )
      );

    }

    const codeRow = await get(
      `
      SELECT id
      FROM email_codes
      WHERE email=?
        AND code=?
        AND datetime(created_at)
            >= datetime('now','-15 minutes')
      ORDER BY id DESC
      LIMIT 1
      `,
      [email, code]
    );

    if(!codeRow){

      return res.status(400).send(
        tr(
          req,
          "Code incorrect ou expiré",
          "Invalid or expired code"
        )
      );

    }

    const hashedPassword =
      await bcrypt.hash(password, 10);

    await run("BEGIN TRANSACTION");

    try{

      await run(
        `
        UPDATE users
        SET password=?
        WHERE id=?
        `,
        [
          hashedPassword,
          user.id
        ]
      );

      await run(
        `
        DELETE FROM email_codes
        WHERE email=?
        `,
        [email]
      );

      await run("COMMIT");

    }catch(error){

      await run("ROLLBACK");
      throw error;

    }

    return res.send(
      tr(
        req,
        "Mot de passe changé",
        "Password changed"
      )
    );

  }catch(e){

    console.error(
      "Erreur reset password :",
      e
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur réinitialisation du mot de passe",
        "Password reset failed"
      )
    );

  }

});

app.post(
  "/add-highlight-comment",
  async (req,res)=>{

    try{

      if(!connected(req)){

        return res.status(401).send(
          tr(
            req,
            "Connecte-toi pour commenter",
            "Log in to comment"
          )
        );

      }

      const highlightId =
        Number(req.body.highlight_id);

      const comment =
        String(req.body.comment || "")
          .trim();

      if(
        !Number.isInteger(highlightId) ||
        highlightId <= 0
      ){

        return res.status(400).send(
          tr(
            req,
            "Vidéo invalide",
            "Invalid video"
          )
        );

      }

      if(!comment){

        return res.status(400).send(
          tr(
            req,
            "Commentaire obligatoire",
            "Comment is required"
          )
        );

      }

      if(comment.length > 500){

        return res.status(400).send(
          tr(
            req,
            "Le commentaire ne doit pas dépasser 500 caractères",
            "The comment must not exceed 500 characters"
          )
        );

      }

      if(containsBadWords(comment)){

        return res.status(400).send(
          tr(
            req,
            "Contenu interdit détecté",
            "Forbidden content detected"
          )
        );

      }

      const highlight = await get(
        `
        SELECT id, user_id
        FROM highlights
        WHERE id=?
        `,
        [highlightId]
      );

      if(!highlight){

        return res.status(404).send(
          tr(
            req,
            "Vidéo introuvable",
            "Video not found"
          )
        );

      }

      await run(
        `
        INSERT INTO highlight_comments(
          highlight_id,
          user_id,
          comment
        )
        VALUES(?,?,?)
        `,
        [
          highlightId,
          req.session.userId,
          comment
        ]
      );

      if(
        highlight.user_id &&
        Number(highlight.user_id) !==
        Number(req.session.userId)
      ){

        await notifierUtilisateur(
          highlight.user_id,
          "💬 Nouveau commentaire",
          "Quelqu'un a commenté ta vidéo",
          `video:${highlightId}`
        );

      }

      return res.send(
        tr(
          req,
          "Commentaire ajouté",
          "Comment added"
        )
      );

    }catch(error){

      console.error(
        "Erreur ajout commentaire :",
        error
      );

      return res.status(500).send(
        tr(
          req,
          "Erreur commentaire",
          "Failed to add comment"
        )
      );

    }

  }
);

app.get("/highlight-comments/:id", async (req,res)=>{

  try{

    const rows = await all(
      `
      SELECT
        highlight_comments.*,
        highlight_comments.user_id,
        users.name,
        users.username,
        users.profile_photo
      FROM highlight_comments
      LEFT JOIN users
      ON users.id = highlight_comments.user_id
      WHERE highlight_comments.highlight_id=?
      ORDER BY highlight_comments.id DESC
      `,
      [req.params.id]
    );

    res.json(rows);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.post("/delete-highlight-comment", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.send("Connecte-toi");
    }

    const { comment_id } = req.body;

    if(!comment_id){
      return res.send("Commentaire introuvable");
    }

    const comment = await get(
      `
      SELECT *
      FROM highlight_comments
      WHERE id=?
      `,
      [comment_id]
    );

    if(!comment){
      return res.send("Commentaire introuvable");
    }

    if(Number(comment.user_id) !== Number(req.session.userId)){
      return res.send("Tu ne peux supprimer que ton commentaire");
    }

    await run(
      `
      DELETE FROM highlight_comments
      WHERE id=?
      `,
      [comment_id]
    );

    res.send("Commentaire supprimé");

  }catch(e){

    console.log(e);
    res.send("Erreur suppression commentaire");

  }

});

 app.get("/public-profile/:id", async (req,res)=>{

  try{

    const userId = req.params.id;

    const user = await get(
      `
      SELECT
        id,
        name,
        username,
        profile_photo
      FROM users
      WHERE id=?
      `,
      [userId]
    );

    if(!user){
      return res.json({
        error:"Profil introuvable"
      });
    }

    const stats = await get(
  `
  SELECT
    (
      SELECT COUNT(*)
      FROM follows
      WHERE following_participant_id=?
    ) AS followers,

    (
      SELECT COUNT(*)
      FROM follows
      WHERE follower_id=?
    ) AS following,

    (
      SELECT COALESCE(SUM(likes),0)
      FROM highlights
      WHERE user_id=?
    ) AS likes
  `,
  [
    userId,
    userId,
    userId
  ]
);

    let isFollowing = 0;

if(req.session.userId){
  const follow = await get(
  `
  SELECT id
  FROM follows
  WHERE follower_id=?
    AND following_participant_id=?
  `,
  [
    req.session.userId,
    userId
  ]
);

  isFollowing = follow ? 1 : 0;
}

    const viewerId =
  req.session.userId || 0;

const videos = await all(
  `
  SELECT
    h.*,

    CASE
      WHEN vf.id IS NULL THEN 0
      ELSE 1
    END AS favorited,

    (
      SELECT COUNT(*)
      FROM video_favorites vf2
      WHERE vf2.highlight_id = h.id
    ) AS favorites,

    (
      SELECT COUNT(*)
      FROM highlight_comments hc
      WHERE hc.highlight_id = h.id
    ) AS comments

  FROM highlights h

  LEFT JOIN video_favorites vf
    ON vf.highlight_id = h.id
    AND vf.user_id = ?

  WHERE h.user_id=?

  ORDER BY h.id DESC
  `,
  [
    viewerId,
    userId
  ]
);

    res.json({
      ...user,
      followers:stats.followers || 0,
      following:stats.following || 0,
      likes:stats.likes || 0,
      isFollowing,
      videos
    });

  }catch(e){

    console.log(e);
    res.json({
      error:"Erreur profil public"
    });

  }

});

app.get("/politique-confidentialite", (req,res)=>{

  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Politique de confidentialité - SunuGame</title>
<style>
body{
  font-family: Arial, sans-serif;
  max-width: 900px;
  margin: auto;
  padding: 25px;
  line-height: 1.6;
}
h1,h2{
  color:#111827;
}
</style>
</head>
<body>

<h1>Politique de confidentialité - SunuGame</h1>

<p>
SunuGame respecte la vie privée de ses utilisateurs et s'engage à protéger leurs données personnelles.
</p>

<h2>Données collectées</h2>

<ul>
<li>Nom</li>
<li>Nom d'utilisateur</li>
<li>Adresse e-mail</li>
<li>Photo de profil</li>
<li>Vidéos publiées</li>
<li>Commentaires</li>
<li>Statistiques de jeu</li>
</ul>

<h2>Utilisation des données</h2>

<ul>
<li>Créer et gérer les comptes utilisateurs</li>
<li>Organiser les tournois sportifs</li>
<li>Afficher les profils et contenus publiés</li>
<li>Améliorer les services de SunuGame</li>
<li>Assurer la sécurité de la plateforme</li>
</ul>

<h2>Partage des données</h2>

<p>
SunuGame ne vend pas les données personnelles des utilisateurs à des tiers.
</p>

<h2>Sécurité</h2>

<p>
Des mesures raisonnables sont mises en œuvre pour protéger les données des utilisateurs.
</p>

<h2>Contenus publiés</h2>

<p>
Les vidéos, commentaires et profils publiés peuvent être visibles par les autres utilisateurs.
</p>

<h2>Contact</h2>

<p>
Email : sunugame054@gmail.com
</p>

<h2>Mises à jour</h2>

<p>
Cette politique de confidentialité peut être modifiée à tout moment.
</p>

</body>
</html>
  `);

});
app.get("/delete-account", (req,res)=>{

  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Suppression de compte - SunuGame</title>
<style>
body{
  font-family: Arial, sans-serif;
  max-width: 900px;
  margin: auto;
  padding: 25px;
  line-height: 1.6;
}
h1,h2{
  color:#111827;
}
</style>
</head>
<body>

<h1>Suppression de compte SunuGame</h1>

<p>
Les utilisateurs de SunuGame peuvent demander la suppression de leur compte et des données associées.
</p>

<h2>Comment demander la suppression ?</h2>

<p>
Envoyez un e-mail à :
</p>

<p>
<strong>sunugame054@gmail.com</strong>
</p>

<p>
Objet de l'e-mail :
</p>

<p>
<strong>Suppression de compte SunuGame</strong>
</p>

<h2>Données supprimées</h2>

<ul>
<li>Compte utilisateur</li>
<li>Nom</li>
<li>Nom d'utilisateur</li>
<li>Adresse e-mail</li>
<li>Photo de profil</li>
<li>Commentaires</li>
<li>Statistiques associées au compte</li>
</ul>

<h2>Délai de traitement</h2>

<p>
Après réception de la demande et vérification de l'identité du demandeur, la suppression du compte sera traitée dans un délai raisonnable.
</p>

<h2>Contact</h2>

<p>
Pour toute question, contactez-nous à :
<br>
<strong>sunugame054@gmail.com</strong>
</p>

</body>
</html>
  `);

});

app.post("/favorite-video", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      );

    }

    const highlightId =
      Number(req.body.highlight_id);

    if(
      !Number.isInteger(highlightId) ||
      highlightId <= 0
    ){

      return res.status(400).send(
        tr(
          req,
          "Vidéo invalide",
          "Invalid video"
        )
      );

    }

    const video = await get(
      `
      SELECT id
      FROM highlights
      WHERE id=?
      `,
      [highlightId]
    );

    if(!video){

      return res.status(404).send(
        tr(
          req,
          "Vidéo introuvable",
          "Video not found"
        )
      );

    }

    const existing = await get(
      `
      SELECT id
      FROM video_favorites
      WHERE user_id=?
        AND highlight_id=?
      `,
      [
        req.session.userId,
        highlightId
      ]
    );

    if(existing){

      await run(
        `
        DELETE FROM video_favorites
        WHERE user_id=?
          AND highlight_id=?
        `,
        [
          req.session.userId,
          highlightId
        ]
      );

      return res.send(
        tr(
          req,
          "Favori retiré",
          "Favorite removed"
        )
      );

    }

    await run(
      `
      INSERT OR IGNORE INTO video_favorites(
        user_id,
        highlight_id
      )
      VALUES(?,?)
      `,
      [
        req.session.userId,
        highlightId
      ]
    );

    return res.send(
      tr(
        req,
        "Favori ajouté",
        "Favorite added"
      )
    );

  }catch(error){

    console.error(
      "Erreur favori vidéo :",
      error
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur favori",
        "Favorite failed"
      )
    );

  }

});

app.get("/my-favorite-videos", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.json([]);
    }

    const videos = await all(
      `
      SELECT
        h.*,
        u.username,
        u.name,
        u.profile_photo,
        1 AS favorited,

        (
          SELECT COUNT(*)
          FROM video_favorites vf2
          WHERE vf2.highlight_id = h.id
        ) AS favorites,

        (
          SELECT COUNT(*)
          FROM highlight_comments hc
          WHERE hc.highlight_id = h.id
        ) AS comments

      FROM video_favorites vf
      JOIN highlights h
        ON h.id = vf.highlight_id
      LEFT JOIN users u
        ON u.id = h.user_id

      WHERE vf.user_id=?

      ORDER BY vf.id DESC
      `,
      [req.session.userId]
    );

    res.json(videos);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.get("/notifications-unread-count", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.json({count:0});
    }

    const result = await get(
      `
      SELECT COUNT(*) AS total
      FROM notifications
      WHERE user_id=?
      AND seen=0
      `,
      [req.session.userId]
    );

    res.json({
      count: result.total || 0
    });

  }catch(e){

    console.log(e);

    res.json({
      count:0
    });

  }

});
async function notifierUtilisateur(userId, titre, message, action = ""){

  try{

    await run(
      `
      INSERT INTO notifications(
        user_id,
        message,
        created_at
      )
      VALUES(?,?,datetime('now'))
      `,
      [
        userId,
        action
          ? `${message}|${action}`
          : message
      ]
    );

    const tokenRow = await get(
      `
      SELECT token
      FROM fcm_tokens
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 1
      `,
      [userId]
    );

    if(tokenRow && tokenRow.token){
      await envoyerNotificationPush(
        tokenRow.token,
        titre,
        message
      );
    }

  }catch(e){

    console.log("Erreur notifierUtilisateur :", e);

  }

}

app.post("/notifications-read", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).json({
        ok:false,
        message:tr(
          req,
          "Connecte-toi",
          "Please log in"
        )
      });

    }

    const result = await run(
      `
      UPDATE notifications
      SET seen=1
      WHERE user_id=?
        AND seen=0
      `,
      [req.session.userId]
    );

    return res.json({
      ok:true,
      updated:
        Number(result.changes || 0)
    });

  }catch(error){

    console.error(
      "Erreur lecture notifications :",
      error
    );

    return res.status(500).json({
      ok:false,
      message:tr(
        req,
        "Erreur notifications",
        "Notifications error"
      )
    });

  }

});

app.post("/save-fcm-token", async (req,res)=>{

  try{

    if(!connected(req)){

      return res.status(401).send(
        tr(
          req,
          "Non connecté",
          "Not logged in"
        )
      );

    }

    const token =
      String(req.body.token || "")
        .trim();

    if(!token){

      return res.status(400).send(
        tr(
          req,
          "Token manquant",
          "Token is missing"
        )
      );

    }

    if(
      token.length < 50 ||
      token.length > 4096
    ){

      return res.status(400).send(
        tr(
          req,
          "Token Firebase invalide",
          "Invalid Firebase token"
        )
      );

    }

    /*
      Si ce token était lié à un ancien compte,
      on le rattache au compte actuellement connecté.
    */
    await run(
      `
      DELETE FROM fcm_tokens
      WHERE token=?
        AND user_id<>?
      `,
      [
        token,
        req.session.userId
      ]
    );

    await run(
      `
      INSERT INTO fcm_tokens(
        user_id,
        token,
        created_at
      )
      VALUES(?,?,datetime('now'))
      ON CONFLICT(token)
      DO UPDATE SET
        user_id=excluded.user_id,
        created_at=datetime('now')
      `,
      [
        req.session.userId,
        token
      ]
    );

    return res.send(
      tr(
        req,
        "Token enregistré",
        "Token saved"
      )
    );

  }catch(error){

    console.error(
      "Erreur enregistrement FCM :",
      error.message
    );

    return res.status(500).send(
      tr(
        req,
        "Erreur token FCM",
        "FCM token error"
      )
    );

  }

});
app.post("/send-reward", async (req,res)=>{

  try{

    if(!isAdmin(req)){

      return res
        .status(403)
        .send("Accès admin refusé");

    }

    const userId =
      Number(req.body.user_id);

    const reward =
      String(req.body.reward || "")
        .trim();

    if(
      !Number.isInteger(userId) ||
      userId <= 0
    ){

      return res
        .status(400)
        .send(
          "Identifiant utilisateur invalide"
        );

    }

    if(!reward){

      return res
        .status(400)
        .send(
          "Récompense obligatoire"
        );

    }

    if(reward.length > 150){

      return res
        .status(400)
        .send(
          "La récompense ne doit pas dépasser 150 caractères"
        );

    }

    if(containsBadWords(reward)){

      return res
        .status(400)
        .send(
          "Contenu interdit détecté"
        );

    }

    const user = await get(
      `
      SELECT id
      FROM users
      WHERE id=?
      `,
      [userId]
    );

    if(!user){

      return res
        .status(404)
        .send(
          "Utilisateur introuvable"
        );

    }

    await run(
      `
      INSERT INTO rewards(
        user_id,
        reward,
        sender_id
      )
      VALUES(?,?,?)
      `,
      [
        userId,
        reward,
        0
      ]
    );

    await notifierUtilisateur(
      userId,
      "🎁 Récompense reçue",
      "Tu as reçu : " + reward,
      "reward"
    );

    return res.send(
      "Récompense envoyée"
    );

  }catch(error){

    console.error(
      "Erreur récompense :",
      error
    );

    return res
      .status(500)
      .send(
        "Erreur récompense"
      );

  }

});
app.get("/my-rewards", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.json([]);
    }

    const rewards = await all(
      `
      SELECT *
      FROM rewards
      WHERE user_id=?
      ORDER BY id DESC
      `,
      [req.session.userId]
    );

    res.json(rewards);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});
app.get("/admin/videos", async (req,res)=>{

  try{

    if(!isAdmin(req)){
      return res.send("Accès admin refusé");
    }

    const videos = await all(
      `
      SELECT
        h.id,
        h.titre,
        h.description,
        h.media_url,
        h.thumbnail_url,
        h.created_at,
        h.user_id,
        u.name,
        u.username,
        u.email
      FROM highlights h
      LEFT JOIN users u
        ON u.id=h.user_id
      ORDER BY h.id DESC
      `
    );

    res.json(videos);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});
app.post("/admin/delete-video-warning", async (req,res)=>{

  try{

    if(!isAdmin(req)){
      return res.send("Accès admin refusé");
    }

    const { video_id, reason } = req.body;

    if(!video_id || !reason){
      return res.send("Vidéo et raison obligatoires");
    }

    const video = await get(
      `
      SELECT *
      FROM highlights
      WHERE id=?
      `,
      [video_id]
    );

    if(!video){
      return res.send("Vidéo introuvable");
    }

    await run(
      `
      INSERT INTO warnings(
        user_id,
        admin_id,
        reason,
        video_id
      )
      VALUES(?,?,?,?)
      `,
      [
        video.user_id,
        req.session.userId || 0,
        reason,
        video_id
      ]
    );

    await notifierUtilisateur(
      video.user_id,
      "⚠️ Avertissement",
      "Ta vidéo a été supprimée : " + reason,
      "warning"
    );

    await run(
      `
      DELETE FROM highlights
      WHERE id=?
      `,
      [video_id]
    );

    res.send("Vidéo supprimée et avertissement envoyé");

  }catch(e){

    console.log(e);
    res.send("Erreur suppression vidéo");

  }

});
app.get("/admin/videos-page", async (req,res)=>{

  if(!isAdmin(req)){
    return res.send("Accès admin refusé");
  }

  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin vidéos SNUGAME</title>
<style>
body{
  background:#07111f;
  color:white;
  font-family:Arial;
  padding:20px;
}
.card{
  background:#0f172a;
  border:1px solid #334155;
  border-radius:16px;
  padding:15px;
  margin:15px 0;
}
video,img{
  width:100%;
  max-width:320px;
  border-radius:12px;
}
button{
  padding:12px;
  border:none;
  border-radius:10px;
  background:#ef4444;
  color:white;
  font-weight:bold;
  cursor:pointer;
}
textarea{
  width:100%;
  min-height:70px;
  margin:10px 0;
}
</style>
</head>
<body>

<h1>🎥 Admin vidéos SNUGAME</h1>

<div id="videos"></div>

<script>
const ADMIN_PASSWORD = new URLSearchParams(location.search).get("admin");

async function chargerVideos(){

  const res = await fetch("/admin/videos?admin=" + ADMIN_PASSWORD);
  const videos = await res.json();

  document.getElementById("videos").innerHTML =
    videos.length
    ? videos.map(v => \`
      <div class="card">
        <h2>\${v.titre || "Sans titre"}</h2>

        <p>
          <b>Publié par :</b>
          \${v.name || ""} (@\${v.username || ""})<br>
          <b>Email :</b> \${v.email || ""}<br>
          <b>User ID :</b> \${v.user_id}<br>
          <b>Vidéo ID :</b> \${v.id}
        </p>

        <video controls src="\${v.media_url}"></video>

        <textarea
        id="reason_\${v.id}"
        placeholder="Raison de suppression / avertissement"></textarea>

        <button onclick="supprimerVideo(\${v.id})">
          Supprimer + avertir
        </button>
      </div>
    \`).join("")
    : "<p>Aucune vidéo.</p>";
}

async function supprimerVideo(id){

  const reason =
    document.getElementById("reason_" + id).value.trim();

  if(!reason){
    alert("Écris une raison");
    return;
  }

  if(!confirm("Supprimer cette vidéo et avertir le joueur ?")){
    return;
  }

  const res = await fetch(
    "/admin/delete-video-warning?admin=" + ADMIN_PASSWORD,
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        video_id:id,
        reason
      })
    }
  );

  alert(await res.text());
  chargerVideos();
}

chargerVideos();
</script>

</body>
</html>
  `);

});

app.post("/video-watch-time", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Non connecté");
    }

    const {
      highlight_id,
      seconds,
      percent
    } = req.body;

    await run(
      `
      INSERT INTO video_watch_time(
        user_id,
        highlight_id,
        seconds,
        percent
      )
      VALUES(?,?,?,?)
      `,
      [
        req.session.userId,
        highlight_id,
        seconds || 0,
        percent || 0
      ]
    );

    res.send("OK");

  }catch(e){

    console.log(e);
    res.send("Erreur");

  }

});

app.get("/join-info/:code", async (req,res)=>{

  try{

    const code = req.params.code;

    const tournoi = await get(
      `
      SELECT id, name, group_link
      FROM tournaments
      WHERE join_code=?
      `,
      [code]
    );

    if(!tournoi){
      return res.json({
        ok:false,
        message:"Lien tournoi invalide"
      });
    }

    res.json({
      ok:true,
      tournament_id:tournoi.id,
      tournament_name:tournoi.name,
      group_link:tournoi.group_link || ""
    });

  }catch(e){

    console.log(e);

    res.json({
      ok:false,
      message:"Erreur lien tournoi"
    });

  }

});

app.get("/owner/:tournament_id", async (req,res)=>{

  try{

    const tournoi = await get(
      `
      SELECT user_id
      FROM tournaments
      WHERE id=?
      `,
      [req.params.tournament_id]
    );

    if(!tournoi){
      return res.json({
        owner:false
      });
    }

    res.json({
      owner:Number(tournoi.user_id) === Number(req.session.userId)
    });

  }catch(e){

    res.json({
      owner:false
    });

  }

});

app.get("/mes-tournois-participant", async (req,res)=>{

  if(!connected(req)){
    return res.json([]);
  }

  const user = await get(
    `
    SELECT email
    FROM users
    WHERE id=?
    `,
    [req.session.userId]
  );

  const rows = await all(
    `
    SELECT DISTINCT
      t.id,
      t.name,
      t.status,
      t.max_teams
    FROM tournaments t
    JOIN participants p
    ON p.tournament_id = t.id
    WHERE p.user_id=?
    OR p.email=?
    ORDER BY t.id DESC
    `,
    [
      req.session.userId,
      user ? user.email : ""
    ]
  );

  res.json(rows);

});

app.get("/mes-groupes-tournois", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.json([]);
    }

    const rows = await all(
      `
      SELECT
        t.name,
        t.group_link
      FROM participants p
      JOIN tournaments t
        ON t.id = p.tournament_id
      WHERE p.user_id=?
      AND t.group_link IS NOT NULL
      AND t.group_link != ''
      ORDER BY p.id DESC
      LIMIT 3
      `,
      [req.session.userId]
    );

    res.json(rows);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});


app.get("/test-dashboard/:tournament_id", async (req,res)=>{

  if(!connected(req)){
    return res.redirect("/login");
  }

  res.redirect("/app?tournament=" + req.params.tournament_id);

});

app.get("/tournoi-access/:id", async (req,res)=>{

  if(!connected(req)){
    return res.json({ ok:false });
  }

  const user = await get(
    `SELECT email FROM users WHERE id=?`,
    [req.session.userId]
  );

  const tournoi = await get(
    `
    SELECT DISTINCT
      t.*,
      pchamp.prenom AS champion_name
    FROM tournaments t
    LEFT JOIN participants p
    ON p.tournament_id = t.id
    LEFT JOIN participants pchamp
    ON pchamp.id = t.champion_id
    WHERE t.id=?
    AND (
      t.user_id=?
      OR p.user_id=?
      OR p.email=?
    )
    `,
    [
      req.params.id,
      req.session.userId,
      req.session.userId,
      user ? user.email : ""
    ]
  );

  if(!tournoi){
    return res.json({ ok:false });
  }

  res.json({
    ok:true,
    tournoi
  });

});

function determinerPremierTourFinal(
  nombreQualifies
){

  if(nombreQualifies === 32){
    return "16ES";
  }

  if(nombreQualifies === 16){
    return "8ES";
  }

  if(nombreQualifies === 8){
    return "QUARTS";
  }

  if(nombreQualifies === 4){
    return "DEMIS";
  }

  if(nombreQualifies === 2){
    return "FINALE";
  }

  return null;

}


app.listen(PORT, () => {

  console.log(
    "Serveur lancé sur le port " + PORT
  );

});