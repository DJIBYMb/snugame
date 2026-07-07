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


if(process.env.FIREBASE_SERVICE_ACCOUNT){

  const serviceAccount =
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  if(!getApps().length){
    initializeApp({
      credential: cert(serviceAccount)
    });
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

app.set("trust proxy", 1);

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
`);db.run(`
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

    res.json(
      highlights.map(h=>({
       ...h,
       current_user_id:req.session.userId
     }))
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
      SELECT *
      FROM email_codes
      WHERE email=?
      AND code=?
      ORDER BY id DESC
      `,
      [cleanEmail, code.trim()]
    );

    if(!verification){
      return res.send(
  tr(
    req,
    "Code invalide",
    "Invalid verification code"
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
    return res.send(
  tr(
    req,
    "Connecte-toi",
    "Please log in"
  )
);
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

  res.send(
  tr(
    req,
    "Abonnement activé",
    "Subscription activated"
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

    if(!name){
      return res.send(
  tr(req,"Nom tournoi obligatoire","Tournament name is required")
);
    }

    const maxTeams =
      Number(max_teams) || 48;

    if(maxTeams < 6 || maxTeams > 100){
      return res.send(
  tr(req,"Nombre équipes entre 6 et 100","Number of teams must be between 6 and 100")
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
        name,
        maxTeams,
        "open",
        joinCode,
        group_link || "",
        type || "poule"
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
      return res.send(
        "Maximum " +
        tournoi.max_teams +
        " équipes atteint"
      );
    }

    const cleanUsername =
      participantUsername
      .replace("@","")
      .trim()
      .toLowerCase();

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

   const rows = await all(
     `
     SELECT
     p.*,
     u.profile_photo
     FROM participants p
     LEFT JOIN users u
      ON u.id = p.user_id
     WHERE p.tournament_id=?
     ORDER BY p.id
     `,
     [req.params.id]
    );

    res.json(rows);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.post(
"/supprimer-participants-selection",
async (req,res)=>{

  try{

    const { ids } = req.body;

    const participant = await get(
  `
  SELECT tournament_id
  FROM participants
  WHERE id=?
  `,
  [ids[0]]
);

if(!participant){
  return res.send(
  tr(req,"Participant introuvable","Participant not found")
);
}

const ownerCheck =
  await verifierProprietaireTournoi(
    req,
    participant.tournament_id
  );

if(!ownerCheck.ok){
  return res.send(ownerCheck.message);
}

    if(
      !ids ||
      !Array.isArray(ids) ||
      ids.length === 0
    ){
      return res.send(
  tr(req,"Aucun participant","No participant selected")
);
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

    res.send(
  tr(req,"Participants supprimés","Participants deleted")
);

  }catch(e){

    console.log(e);
    res.send(
  tr(req,"Erreur suppression","Deletion failed")
);

  }

});

app.post(
"/supprimer-tournoi-complet",
async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    if(!tournament_id){
      return res.send(
  tr(req,"Tournoi manquant","Tournament is missing")
);
    }

    const ownerCheck =
  await verifierProprietaireTournoi(req, tournament_id);

if(!ownerCheck.ok){
  return res.send(ownerCheck.message);
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

    res.send(
  tr(req,"Tournoi supprimé","Tournament deleted")
);

  }catch(e){

    console.log(e);
    res.send(
  tr(req,"Erreur suppression tournoi","Tournament deletion failed")
);

  }

});

app.post("/reset-tournoi", async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    if(!tournament_id){
      return res.send(
  tr(req,"Tournoi obligatoire","Tournament is required")
);
    }

    const ownerCheck =
  await verifierProprietaireTournoi(req, tournament_id);

if(!ownerCheck.ok){
  return res.send(ownerCheck.message);
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

    res.send(
  tr(req,"Tournoi réinitialisé","Tournament reset")
);

  }catch(e){

    console.log(e);
    res.send(
  tr(req,"Erreur reset tournoi","Tournament reset failed")
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

  const dejaRecompense = await get(
  `
  SELECT id
  FROM user_trophies
  WHERE user_id=?
  AND tournament_id=?
  AND trophy=?
  `,
  [
    champion.user_id,
    tournament_id,
    "🏆 Champion"
  ]
);

if(dejaRecompense){
  return;
}

  await run(
    `
    UPDATE user_player_stats
    SET tournois_gagnes = tournois_gagnes + 1,
        coupes = coupes + 1,
        xp = xp + 100,
        niveau = CAST((xp + 100) / 100 AS INTEGER) + 1
    WHERE user_id=?
    AND season_year=?
    `,
    [
      champion.user_id,
      new Date().getFullYear()
    ]
  );

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
      tournoi ? tournoi.name : "Tournoi",
      "🏆 Champion"
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
app.post("/update-match-proof", async (req,res)=>{

  try{

    const {
      match_id,
      score1,
      score2,
      photo_url
    } = req.body;

    if(!match_id){
      return res.send(
        tr(req,"Match obligatoire","Match is required")
      );
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

    if(Number.isNaN(s1) || Number.isNaN(s2)){
      return res.send(
        tr(req,
          "Score invalide",
          "Invalid score"
        )
      );
    }

    if(s1 < 0 || s2 < 0 || s1 > 100 || s2 > 100){
      return res.send(
        tr(req,
          "Score entre 0 et 100",
          "Score between 0 and 100"
        )
      );
    }

    if(match.round !== "POULE" && s1 === s2){
      return res.send(
  tr(
    req,
    "Match nul interdit en élimination directe",
    "Draws are not allowed in knockout matches"
  )
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

    if(match.round === "FINALE" && winner){

  await run(
    `
    UPDATE tournaments
    SET champion_id=?,
        status='finished'
    WHERE id=?
    `,
    [
      winner,
      match.tournament_id
    ]
  );
  await compterTournoiTermine(match.tournament_id);

  await recompenserChampion(
  match.tournament_id,
  winner
 );
  await compterTournoiTermine(match.tournament_id);

  const officiel =
  await tournoiOfficiel(match.tournament_id);

if(officiel){

  const championUser = await get(
    `
    SELECT user_id
    FROM participants
    WHERE id=?
    `,
    [winner]
  );

  const tournoi = await get(
    `
    SELECT name
    FROM tournaments
    WHERE id=?
    `,
    [match.tournament_id]
  );

  if(championUser && championUser.user_id){

    await assurerStatsJoueur(championUser.user_id);

    await run(
      `
      UPDATE user_player_stats
      SET coupes = coupes + 1,
          tournois_gagnes = tournois_gagnes + 1,
          xp = xp + 100,
          niveau = CAST((xp + 100) / 100 AS INTEGER) + 1
      WHERE user_id=?
      AND season_year=?
      `,
      [
        championUser.user_id,
        new Date().getFullYear()
      ]
    );

    await run(
      `
      INSERT INTO user_trophies(
        user_id,
        tournament_id,
        tournament_name,
        trophy
      )
      VALUES(?,?,?,?)
      `,
      [
        championUser.user_id,
        match.tournament_id,
        tournoi ? tournoi.name : "Tournoi",
        "🏆 Champion"
      ]
    );

    await notifierUtilisateur(
  championUser.user_id,
  "👑 Félicitations !",
  `Tu as remporté le tournoi "${tournoi.name}". Bravo Champion ! 🏆`,
  `tournament:${match.tournament_id}`
);
  }

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

  await gererTournoiRapideApresScore(match);

return res.send("Score validé");

}catch(e){

  console.log(e);
  res.send(
    tr(req,"Erreur validation score : " + e.message,"Error validating score : " + e.message)
  );

}

});

app.post("/annuler-score", async (req,res)=>{

  try{

    const { match_id } = req.body;

    if(!match_id){
      return res.send(
        tr(req,"Match obligatoire","Match is required")
      );
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
      return res.send(
        tr(req,"Match introuvable","Match not found")
      );
    }

    if(match.locked === 1){
      return res.send(
        tr(req,"Score verrouillé impossible à annuler","Score is locked and cannot be cancelled")
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

app.post("/upload-image",(req,res)=>{

  upload.single("image")(req,res,async (err)=>{

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

        fs.writeFileSync(tempVideo, req.file.buffer);

        await new Promise((resolve)=>{
          execFile(
            "ffmpeg",
            [
              "-y",
              "-i",tempVideo,
              "-frames:v","1",
              "-q:v","2",
              tempThumb
            ],
            ()=>{
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

        if(fs.existsSync(tempVideo)){
          fs.unlinkSync(tempVideo);
        }

        if(fs.existsSync(tempThumb)){
          fs.unlinkSync(tempThumb);
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
      return res.send("Connecte-toi");
    }

    const { id } = req.body;

    const dejaLike = await get(
      `
      SELECT *
      FROM highlight_likes
      WHERE highlight_id=?
      AND user_id=?
      `,
      [
        id,
        req.session.userId
      ]
    );

    if(dejaLike){

      await run(
        `
        DELETE FROM highlight_likes
        WHERE highlight_id=?
        AND user_id=?
        `,
        [
          id,
          req.session.userId
        ]
      );

      await run(
        `
        UPDATE highlights
        SET likes = MAX(likes - 1, 0)
        WHERE id=?
        `,
        [id]
      );

      return res.send("Like retiré");
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
        id,
        req.session.userId
      ]
    );

    await run(
      `
      UPDATE highlights
      SET likes = likes + 1
      WHERE id=?
      `,
      [id]
    );
    
    const video = await get(
  `
  SELECT
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
    id
  ]
);

if(
  video &&
  Number(video.user_id) !== Number(req.session.userId)
){

  await notifierUtilisateur(
    video.user_id,
    "❤️ Nouveau like",
    `${video.username || video.name || "Un joueur"} a aimé ta vidéo`,
    `video:${id}`
  );

}

    res.send("Like ajouté");

  }catch(e){

    console.log(e);
    res.send("Erreur like");

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

    const video = await get(
  `
  SELECT
    h.user_id,
    h.titre,
    p.prenom
  FROM highlights h
  LEFT JOIN participants p
    ON p.id=?
  WHERE h.id=?
  `,
  [
    participant_id,
    highlight_id
  ]
);

if(
  video &&
  Number(video.user_id) !== Number(req.session.userId)
){

  await notifierUtilisateur(
    video.user_id,
    "💬 Nouveau commentaire",
    `${video.prenom || "Un joueur"} a commenté ta vidéo`,
    `video:${highlight_id}`
  );

}

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

    if(!req.session.userId){
      return res.send("Connecte-toi d'abord");
    }

    const { player_user_id } = req.body;

    if(!player_user_id){
      return res.send("Joueur manquant");
    }

    if(Number(player_user_id) === Number(req.session.userId)){
      return res.send("Tu ne peux pas te suivre toi-même");
    }


const existing = await get(
  `
  SELECT id
  FROM followers
  WHERE follower_id=?
  AND following_id=?
  `,
  [
    req.session.userId,
    player_user_id
  ]
);

if(existing){

  await run(
    `
    DELETE FROM followers
    WHERE id=?
    `,
    [existing.id]
  );

  return res.send("Unfollow");

}

    await run(
      `
      INSERT INTO followers(
        follower_id,
        following_id
      )
      VALUES(?,?)
      `,
      [req.session.userId, player_user_id]
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
  player_user_id,
  "🔔 Nouvel abonné",
  `${me?.username || me?.name || "Un joueur"} s'est abonné à toi`,
  `profile:${req.session.userId}`
);

    res.send("Abonnement réussi ✅");

  }catch(e){

    console.log(e);
    res.send("Erreur abonnement joueur");

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
app.post("/tirage-automatique-poule-pro", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi");
    }

    const { tournament_id } = req.body;

    const ownerCheck =
  await verifierProprietaireTournoi(req, tournament_id);

if(!ownerCheck.ok){
  return res.send(ownerCheck.message);
}

    if(!tournament_id){
      return res.send("Tournoi obligatoire");
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

    const participants = await all(
      `
      SELECT *
      FROM participants
      WHERE tournament_id=?
      ORDER BY id
      `,
      [tournament_id]
    );

    if(participants.length < 2){
      return res.send("Il faut au moins 2 participants");
    }

    const dejaMatchs = await get(
      `
      SELECT COUNT(*) AS total
      FROM matches
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    if(Number(dejaMatchs.total || 0) === 0){

      if(tournoi.type === "rapide"){

  if(participants.length !== 32){
    return res.send("Le tournoi rapide exige exactement 32 équipes");
  }

  const tirage =
    genererMatchsRapide(participants);

  if(tirage.error){
    return res.send(tirage.error);
  }

  let matchOrder = 1;

  for(const m of tirage.matchs){

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
        tournament_id,
        m.round,
        matchOrder++,
        m.leg,
        m.player1.id,
        m.player2.id
      ]
    );

  }

  await run(
    `
    UPDATE tournaments
    SET status='started'
    WHERE id=?
    `,
    [tournament_id]
  );

  return res.send("Tournoi rapide 32 généré");
}

      const groupes =
        genererGroupesAuto(participants);

      let matchOrder = 1;

      for(let g=0; g<groupes.length; g++){

        const groupName =
          String.fromCharCode(65 + g);

        for(const p of groupes[g]){

          await run(
            `
            UPDATE participants
            SET group_name=?
            WHERE id=?
            `,
            [
              groupName,
              p.id
            ]
          );

        }

        const rounds =
          genererMatchsPoule(groupes[g]);

        for(const journee of rounds){

          for(const m of journee){

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
                groupName,
                matchOrder++,
                m[0].id,
                m[1].id
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
        [tournament_id]
      );

      for(const p of participants){

        if(!p.user_id){
          continue;
        }

        await notifierUtilisateur(
          p.user_id,
          "🏆 Début du tournoi",
          `Le tournoi "${tournoi.name}" vient de commencer.`,
          `tournament:${tournament_id}`
        );

      }

      return res.send("Tirage poules généré");
    }

    return res.send("Tirage déjà généré");

  }catch(e){

    console.log(e);
    res.send("Erreur tirage : " + e.message);

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
      return res.send(
  tr(
    req,
    "Email obligatoire",
    "Email is required"
  )
);
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
      return res.send(
  tr(
    req,
    "Compte introuvable",
    "Account not found"
  )
);
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
      return res.send("Accès admin refusé");
    }

    const { user_id } = req.body;

    if(!user_id){
      return res.send("Utilisateur obligatoire");
    }

    await run(
      `
      UPDATE users
      SET banned=1
      WHERE id=?
      `,
      [user_id]
    );

    res.send("Utilisateur banni");

  }catch(e){

    console.log(e);
    res.send("Erreur bannissement");

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

<a href="/admin-payments?admin=${ADMIN_PASSWORD}" style="color:#60a5fa;">
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
      <form method="POST" action="/admin-unban-user?admin=${ADMIN_PASSWORD}">
        <input type="hidden" name="user_id" value="${u.id}">
        <button>Débannir</button>
      </form>
    `
    : `
      <form method="POST" action="/admin-ban-user?admin=${ADMIN_PASSWORD}">
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
      return res.send("Accès admin refusé");
    }

    const { user_id } = req.body;

    if(!user_id){
      return res.send("Utilisateur obligatoire");
    }

    await run(
      `
      UPDATE users
      SET banned=0
      WHERE id=?
      `,
      [user_id]
    );

    res.redirect("/admin-users?admin=" + ADMIN_PASSWORD);

  }catch(e){

    console.log(e);
    res.send("Erreur débannissement");

  }

});
app.post("/update-profile-photo", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.send(
  tr(
    req,
    "Connecte-toi",
    "Please log in"
  )
);
    }

    const { photo } = req.body;

    if(!photo){
      return res.send("Photo obligatoire");
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

    res.send("Photo profil mise à jour");

  }catch(e){

    console.log(e);
    res.send("Erreur photo profil");

  }

});
app.post("/follow-player", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.send("Connecte-toi d'abord");
    }

    const { player_user_id } = req.body;

    if(!player_user_id){
      return res.send("Joueur obligatoire");
    }

    if(Number(player_user_id) === Number(req.session.userId)){
      return res.send("Tu ne peux pas t'abonner à toi-même");
    }

    const exist = await get(
      `
      SELECT *
      FROM followers
      WHERE follower_id=?
      AND following_id=?
      `,
      [
        req.session.userId,
        player_user_id
      ]
    );

    if(exist){
      return res.send("Déjà abonné");
    }

    await run(
      `
      INSERT INTO followers(
        follower_id,
        following_id
      )
      VALUES(?,?)
      `,
      [
        req.session.userId,
        player_user_id
      ]
    );

    res.send("Abonnement réussi ✅");

  }catch(e){

    console.log(e);
    res.send("Erreur abonnement joueur");

  }

});
app.post("/update-username", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.send(
  tr(
    req,
    "Connecte-toi",
    "Please log in"
  )
);
    }

    const { username } = req.body;

    if(!username){
      return res.send("Nom utilisateur obligatoire");
    }

    const clean =
      username.trim().toLowerCase();

    if(clean.length < 3){
      return res.send("Minimum 3 caractères");
    }

    if(!/^[a-z0-9._]+$/.test(clean)){
      return res.send("Utilise seulement lettres, chiffres, point ou _");
    }

    const user = await get(
      `
      SELECT username_updated_at
      FROM users
      WHERE id=?
      `,
      [req.session.userId]
    );

    if(user && user.username_updated_at){

      const last = new Date(user.username_updated_at);
      const now = new Date();
      const diffDays =
        (now - last) / (1000 * 60 * 60 * 24);

      if(diffDays < 30){

  const joursRestants =
    Math.ceil(30 - diffDays);

  return res.send(
    `ATTENDRE_30_JOURS:${joursRestants}`
  );
}

    }

    const exist = await get(
      `
      SELECT id
      FROM users
      WHERE username=?
      AND id!=?
      `,
      [clean,req.session.userId]
    );

    if(exist){
      return res.send("Ce nom utilisateur est déjà pris");
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

    res.send("Nom utilisateur mis à jour ✅");

  }catch(e){

    console.log(e);
    res.send("Erreur nom utilisateur");

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
      FROM followers
      WHERE following_id=?
      `,
      [user.id]
    );

    const following = await get(
      `
      SELECT COUNT(*) AS total
      FROM followers
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

    await run(
      `
      DELETE FROM notifications
      WHERE created_at < datetime('now','-30 days')
      `
    );

    if(!req.session.userId){
      return res.json([]);
    }

    const rows = await all(
      `
      SELECT *
      FROM notifications
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 50
      `,
      [req.session.userId]
    );

    res.json(rows);

  }catch(e){

    console.log(e);
    res.json([]);

  }

});

app.post("/delete-highlight", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.send("Connecte-toi");
    }

    const { id } = req.body;

    const highlight = await get(
      `
      SELECT *
      FROM highlights
      WHERE id=?
      `,
      [id]
    );

    if(!highlight){
      return res.send("Vidéo introuvable");
    }

    if(Number(highlight.user_id) !== Number(req.session.userId)){
      return res.send("Tu ne peux supprimer que tes vidéos");
    }

    await run(
      `
      DELETE FROM highlights
      WHERE id=?
      `,
      [id]
    );

    res.send("Vidéo supprimée");

  }catch(e){

    console.log(e);
    res.send("Erreur suppression vidéo");

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

  if(!req.session.userId){
    return res.send("Connecte-toi");
  }

  await run(
    `
    UPDATE highlights
    SET user_id=?
    WHERE user_id IS NULL
    `,
    [req.session.userId]
  );

  res.send("Anciennes vidéos liées à ton compte");
});

app.post("/delete-old-videos", async (req,res)=>{

  if(!req.session.userId){
    return res.send("Connecte-toi");
  }

  await run(`
    DELETE FROM highlights
    WHERE user_id IS NULL
  `);

  res.send("Anciennes vidéos supprimées");
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

  if(!tournoi || tournoi.type !== "rapide"){
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

  if(!updatedMatch || Number(updatedMatch.played) !== 1){
    return;
  }

  const duel = await all(
    `
    SELECT *
    FROM matches
    WHERE tournament_id=?
    AND round=?
    AND (
      (player1_id=? AND player2_id=?)
      OR
      (player1_id=? AND player2_id=?)
    )
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
    duel.find(m => m.journee === "ALLER");

  const retour =
    duel.find(m => m.journee === "RETOUR");

  if(!aller || !retour){
    return;
  }

  if(
    Number(aller.played) !== 1 ||
    Number(retour.played) !== 1
  ){
    return;
  }

  let winner = null;

const player1 = aller.player1_id;
const player2 = aller.player2_id;

const totalPlayer1 =
  Number(aller.score1 || 0) +
  Number(retour.score1 || 0);

const totalPlayer2 =
  Number(aller.score2 || 0) +
  Number(retour.score2 || 0);

const encaissesPlayer1 =
  Number(aller.score2 || 0) +
  Number(retour.score2 || 0);

const encaissesPlayer2 =
  Number(aller.score1 || 0) +
  Number(retour.score1 || 0);

// 1. Score cumulé
if(totalPlayer1 > totalPlayer2){
  winner = player1;
}
else if(totalPlayer2 > totalPlayer1){
  winner = player2;
}

// 2. Moins de buts encaissés
else if(encaissesPlayer1 < encaissesPlayer2){
  winner = player1;
}
else if(encaissesPlayer2 < encaissesPlayer1){
  winner = player2;
}

// 3. Vainqueur du match retour
else if(Number(retour.score1) > Number(retour.score2)){
  winner = retour.player1_id;
}
else if(Number(retour.score2) > Number(retour.score1)){
  winner = retour.player2_id;
}

// 4. Toujours égalité
else{
  return;
}
await qualifierJoueurRapide(
  updatedMatch.tournament_id,
  updatedMatch.round,
  winner
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
  winnerId
){

  if(!winnerId){
    return;
  }

  const nextRound =
    getNextRoundRapide(round);

  if(!nextRound){

    await run(
      `
      UPDATE tournaments
      SET champion_id=?,
          status='finished'
      WHERE id=?
      `,
      [winnerId, tournamentId]
    );

    return;
  }

  await run(
    `
    INSERT INTO rapid_qualifiers(
      tournament_id,
      round,
      player_id
    )
    VALUES(?,?,?)
    `,
    [tournamentId, round, winnerId]
  );

  const qualifies = await all(
    `
    SELECT *
    FROM rapid_qualifiers
    WHERE tournament_id=?
    AND round=?
    ORDER BY id
    `,
    [tournamentId, round]
  );

  if(qualifies.length % 2 !== 0){
    return;
  }

  for(let i=0; i<qualifies.length; i+=2){

    const p1 = qualifies[i].player_id;
    const p2 = qualifies[i + 1].player_id;

    const alreadyPair = await get(
      `
      SELECT id
      FROM matches
      WHERE tournament_id=?
      AND round=?
      AND (
        (player1_id=? AND player2_id=?)
        OR
        (player1_id=? AND player2_id=?)
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
        i + 1,
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
        i + 2,
        "RETOUR",
        p1,
        p2
      ]
    );

  }

}
app.post("/fix-champion/:id", async (req,res)=>{

  const match = await get(
    `
    SELECT *
    FROM matches
    WHERE tournament_id=?
    AND round='FINALE'
    AND played=1
    ORDER BY id DESC
    LIMIT 1
    `,
    [req.params.id]
  );

  if(!match || !match.winner_id){
    return res.send("Aucune finale gagnée trouvée");
  }

  await run(
    `
    UPDATE tournaments
    SET champion_id=?,
        status='finished'
    WHERE id=?
    `,
    [
      match.winner_id,
      req.params.id
    ]
  );

  res.send("Champion corrigé");

});

app.post("/update-name", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi d'abord");
    }

    const { name } = req.body;

    if(!name || !name.trim()){
      return res.send("Nom obligatoire");
    }

    if(containsBadWords(name)){
      return res.send("Contenu interdit détecté");
    }

    await run(
      `
      UPDATE users
      SET name=?
      WHERE id=?
      `,
      [
        name.trim(),
        req.session.userId
      ]
    );

    res.send("Nom modifié");

  }catch(e){

    console.log(e);
    res.send("Erreur modification nom");

  }

});

app.post("/change-password", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi d'abord");
    }

    const {
      oldPassword,
      newPassword
    } = req.body;

    if(!oldPassword || !newPassword){
      return res.send(
  tr(req,
    "Tous les champs sont obligatoires",
    "All fields are required")
);
    }

    if(newPassword.length < 8){
      return res.send(
  tr(req,
    "Mot de passe minimum 8 caractères",
    "Password must be at least 8 characters long")
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
      return res.send("Compte introuvable");
    }

    const ok =
      await bcrypt.compare(
        oldPassword,
        user.password
      );

    if(!ok){
      return res.send("Ancien mot de passe incorrect");
    }

    const hash =
      await bcrypt.hash(newPassword,10);

    await run(
      `
      UPDATE users
      SET password=?
      WHERE id=?
      `,
      [
        hash,
        req.session.userId
      ]
    );

    res.send("Mot de passe changé");

  }catch(e){

    console.log(e);
    res.send("Erreur changement mot de passe");

  }

});

app.post("/send-old-email-code", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi d'abord");
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

    const code =
      Math.floor(100000 + Math.random() * 900000)
      .toString();

    await run(
      `
      INSERT INTO email_codes(email,code)
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
     subject:"Code vérification email SNUGAME",
     text:"Votre code est : " + code
   });

    res.send("Code envoyé à ton email actuel");

  }catch(e){

    console.log(e);
    res.send("Erreur envoi code ancien email");

  }

});
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
      SELECT *
      FROM email_codes
      WHERE email=?
      AND code=?
      ORDER BY id DESC
      `,
      [
        user.email,
        code.trim()
      ]
    );

    if(!verification){
      return res.send("Code invalide");
    }

    res.send("Code valide");

  }catch(e){

    console.log(e);
    res.send("Erreur vérification code");

  }

});
app.post("/send-new-email-code", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi d'abord");
    }

    const { email } = req.body;

    if(!email){
      return res.send("Nouvel email obligatoire");
    }

    const cleanEmail =
      email.trim().toLowerCase();

    const existing = await get(
      `
      SELECT id
      FROM users
      WHERE email=?
      `,
      [cleanEmail]
    );

    if(existing){
      return res.send("Email déjà utilisé");
    }

    const code =
      Math.floor(100000 + Math.random() * 900000)
      .toString();

    await run(
      `
      INSERT INTO email_codes(email,code)
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
     subject:"Code nouvel email SNUGAME",
     text:"Votre code est : " + code
    });

    res.send("Code envoyé au nouvel email");

  }catch(e){

    console.log(e);
    res.send("Erreur envoi code nouvel email");

  }

});
app.post("/confirm-new-email", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi d'abord");
    }

    const { email, code } = req.body;

    if(!email || !code){
      return res.send("Email et code obligatoires");
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

    const existing = await get(
      `
      SELECT id
      FROM users
      WHERE email=?
      `,
      [cleanEmail]
    );

    if(existing){
      return res.send("Email déjà utilisé");
    }

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

    res.send("Nouvelle adresse enregistrée");

  }catch(e){

    console.log(e);
    res.send("Erreur changement email");

  }

});

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

app.post("/reset-password", async (req,res)=>{

  try{

    const email =
      req.body.email.trim().toLowerCase();

    const code =
      String(req.body.code || "").trim();

    const password =
      String(req.body.password || "").trim();

    if(!email || !code || !password){
      return res.send(
  tr(req,
    "Tous les champs sont obligatoires",
    "All fields are required")
);
    }

    if(password.length < 6){
      return res.send(
        tr(req,
          "Mot de passe trop court",
          "Password is too short"
        )
      );
    }

    const user = await get(
      `
      SELECT *
      FROM users
      WHERE email=?
      `,
      [email]
    );

    if(!user){
      return res.send("Email introuvable");
    }

    const codeRow = await get(
      `
      SELECT *
      FROM email_codes
      WHERE email=?
      AND code=?
      ORDER BY id DESC
      LIMIT 1
      `,
      [email, code]
    );

    if(!codeRow){
      return res.send("Code incorrect");
    }

    const hashedPassword =
  await bcrypt.hash(password, 10);

await run(
  `
  UPDATE users
  SET password=?
  WHERE email=?
  `,
  [
    hashedPassword,
    email
  ]
);

    await run(
      `
      DELETE FROM email_codes
      WHERE email=?
      `,
      [email]
    );

    res.send("Mot de passe changé");

  }catch(e){

    console.log(e);
    res.send("Erreur reset password");

  }

});

app.post("/add-highlight-comment", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.send("Connecte-toi pour commenter");
    }

    const { highlight_id, comment } = req.body;

    if(!highlight_id || !comment){
      return res.send("Commentaire obligatoire");
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
        highlight_id,
        req.session.userId,
        comment.trim()
      ]
    );

    res.send("Commentaire ajouté");

  }catch(e){

    console.log(e);
    res.send("Erreur commentaire");

  }

});
app.get("/highlight-comments/:id", async (req,res)=>{

  try{

    const rows = await all(
      `
      SELECT
        highlight_comments.*,
        highlight_comments.user_id,
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
       (SELECT COUNT(*) FROM followers WHERE following_id=?) AS followers,
       (SELECT COUNT(*) FROM followers WHERE follower_id=?) AS following,
       (SELECT COALESCE(SUM(likes),0) FROM highlights WHERE user_id=?) AS likes
      `,
      [userId, userId, userId]
    );

    let isFollowing = 0;

if(req.session.userId){
  const follow = await get(
    `
    SELECT id
    FROM followers
    WHERE follower_id=?
    AND following_id=?
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

    if(!req.session.userId){
      return res.send("Connecte-toi");
    }

    const { highlight_id } = req.body;

    if(!highlight_id){
      return res.send("Vidéo manquante");
    }

    const existing = await get(
      `
      SELECT id
      FROM video_favorites
      WHERE user_id=?
      AND highlight_id=?
      `,
      [req.session.userId, highlight_id]
    );

    if(existing){

      await run(
        `
        DELETE FROM video_favorites
        WHERE id=?
        `,
        [existing.id]
      );

      return res.send("Favori retiré");
    }

    await run(
      `
      INSERT INTO video_favorites(
        user_id,
        highlight_id
      )
      VALUES(?,?)
      `,
      [req.session.userId, highlight_id]
    );

    res.send("Favori ajouté");

  }catch(e){

    console.log(e);
    res.send("Erreur favori");

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

    if(!req.session.userId){
      return res.send("Non connecté");
    }

    await run(
      `
      UPDATE notifications
      SET seen=1
      WHERE user_id=?
      `,
      [req.session.userId]
    );

    res.send("OK");

  }catch(e){

    console.log(e);
    res.send("Erreur notifications");

  }

});
app.post("/save-fcm-token", async (req,res)=>{

  try{

    if(!req.session.userId){
      return res.send("Non connecté");
    }

    const { token } = req.body;

    if(!token){
      return res.send("Token manquant");
    }

    await run(
      `
      INSERT OR REPLACE INTO fcm_tokens(
        user_id,
        token
      )
      VALUES(?,?)
      `,
      [
        req.session.userId,
        token
      ]
    );

    console.log("FCM enregistré :", token);

    res.send("Token enregistré");

  }catch(e){

    console.log(e);
    res.send("Erreur token FCM");

  }

});
app.post("/send-reward", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send("Connecte-toi");
    }

    const { user_id, reward } = req.body;

    if(!user_id || !reward){
      return res.send("Joueur et récompense obligatoires");
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
        user_id,
        reward,
        req.session.userId
      ]
    );

    await notifierUtilisateur(
      user_id,
      "🎁 Récompense reçue",
      "Tu as reçu : " + reward,
      "reward"
    );

    res.send("Récompense envoyée");

  }catch(e){

    console.log(e);
    res.send("Erreur récompense");

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

app.post("/admin/create-test-participants", async (req,res)=>{

  try{

    if(!isAdmin(req)){
      return res.send("Accès admin refusé");
    }

    const { tournament_id } = req.body;

    if(!tournament_id){
      return res.send("Tournoi obligatoire");
    }

    const tournoi = await get(
      `SELECT * FROM tournaments WHERE id=?`,
      [tournament_id]
    );

    if(!tournoi){
      return res.send("Tournoi introuvable");
    }

    await run(
      `DELETE FROM participants WHERE tournament_id=?`,
      [tournament_id]
    );

    await run(
      `DELETE FROM matches WHERE tournament_id=?`,
      [tournament_id]
    );

    await run(
      `DELETE FROM rapid_qualifiers WHERE tournament_id=?`,
      [tournament_id]
    );

    for(let i=1; i<=32; i++){

      const name =
        "Test Joueur " + i;

      const result = await run(
        `
        INSERT INTO participants(
          tournament_id,
          prenom,
          username,
          preuve
        )
        VALUES(?,?,?,?)
        `,
        [
          tournament_id,
          name,
          "test_joueur_" + i,
          "Compte test"
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

    }

    await run(
      `
      UPDATE tournaments
      SET max_teams=32,
          type='rapide',
          status='open',
          champion_id=NULL
      WHERE id=?
      `,
      [tournament_id]
    );

    res.send("32 participants test créés ✅");

  }catch(e){

    console.log(e);
    res.send("Erreur création participants test : " + e.message);

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


app.listen(PORT, () => {

  console.log(
    "Serveur lancé sur le port " + PORT
  );

});