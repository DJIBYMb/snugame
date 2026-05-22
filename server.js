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
const loginLimiter = rateLimit({

  windowMs:15 * 60 * 1000,

  max:10,

  message:
    "Trop de tentatives. Réessaie plus tard."

});

const db = new sqlite3.Database(
  path.join(DATA_DIR, "database.sqlite")
);

app.use(express.json({ limit:"10mb" }));
app.use(express.urlencoded({ extended:true }));
app.use(express.static("public"));

const uploadDir = path.join(DATA_DIR, "uploads");

if(!fs.existsSync(uploadDir)){
  fs.mkdirSync(uploadDir);
}

app.use("/uploads", express.static(uploadDir));

const storage = multer.diskStorage({

  destination:(req,file,cb)=>{
    cb(null, uploadDir);
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
    fileSize:5 * 1024 * 1024
  },

  fileFilter:(req,file,cb)=>{

    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/jpg"
    ];

    if(!allowed.includes(file.mimetype)){
      return cb(
        new Error("Image seulement")
      );
    }

    cb(null,true);

  }

});

app.use("/uploads", express.static(uploadDir));

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
  return req.session &&
         req.session.userId;
}

function run(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.run(sql, params, function(err){
      if(err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.get(sql, params, (err,row)=>{
      if(err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.all(sql, params, (err,rows)=>{
      if(err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function donnerBadge(participant_id, badge){

  await run(
    `
    INSERT OR IGNORE INTO player_badges(
      participant_id,
      badge
    )
    VALUES(?,?)
    `,
    [participant_id, badge]
  );

}

async function ajouterXP(participant_id, xpAjoute){

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
    Number(stats.xp || 0) + xpAjoute;

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
      abonnement INTEGER DEFAULT 0
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
    UNIQUE(participant_id, badge)
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
  ALTER TABLE users
  ADD COLUMN abonnement_expire_at TEXT
`,()=>{});

});

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

app.get("/", (req,res)=>{
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
        "Tous les champs sont obligatoires"
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
        email.trim().toLowerCase(),
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



  const {
    email,
    password
  } = req.body;

  if(!email || !password){
    return res.send(
      "Email et mot de passe obligatoires"
    );
  }

  db.get(
    "SELECT * FROM users WHERE email=?",
    [email.trim().toLowerCase()],
    async (err,user)=>{

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

  db.get(
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
    [req.session.userId],

    async (err,user)=>{

      if(err || !user){
        return res.json({
          connected:false
        });
      }

      if(
        user.abonnement === 1 &&
        user.abonnement_expire_at
      ){

        const maintenant =
          new Date();

        const expiration =
          new Date(
            user.abonnement_expire_at
          );

        if(maintenant > expiration){

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

    }
  );

});

app.post("/abonnement",(req,res)=>{

  if(!connected(req)){
    return res.send(
      "Connecte-toi"
    );
  }

  db.run(
    `
    UPDATE users
    SET abonnement=1
    WHERE id=?
    `,
    [req.session.userId],
    ()=>{
      res.send(
        "Abonnement activé"
      );
    }
  );

});

app.post("/tournoi", async (req,res)=>{

  try{

    if(!connected(req)){
      return res.send(
        "Connecte-toi d'abord"
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

    if(
      !user ||
      user.abonnement !== 1
    ){
      return res.send(
        "Tu dois payer l'abonnement"
      );
    }

    const active = await get(
      `
      SELECT *
      FROM tournaments
      WHERE
      user_id=?
      AND status='active'
      `,
      [req.session.userId]
    );

    if(active){
      return res.send(
        "Tu as déjà un tournoi actif"
      );
    }

    const { name } = req.body;

    if(!name){
      return res.send(
        "Nom tournoi obligatoire"
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
        48,
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
      return res.send(
        "Connecte-toi"
      );
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

    if(
      !tournament_id ||
      !prenom ||
      !email
    ){
      return res.send(
        "Tournoi, prénom et email obligatoires"
      );
    }

    const count = await get(
      `
      SELECT COUNT(*) AS total
      FROM participants
      WHERE tournament_id=?
      `,
      [tournament_id]
    );

    if(count.total >= 48){
      return res.send(
        "Maximum 48 équipes atteint"
      );
    }

    await run(
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

    const participant = await get(
  `
  SELECT id
  FROM participants
  WHERE tournament_id=?
  ORDER BY id DESC
  LIMIT 1
  `,
  [tournament_id]
);

if(participant){
  await run(
    `
    INSERT OR IGNORE INTO player_stats(
      participant_id
    )
    VALUES(?)
    `,
    [participant.id]
  );
}

    res.send("Participant ajouté");

  }catch(e){

    console.log(e);

    res.send(
      "Erreur ajout participant"
    );

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
      return res.send(
        "Aucun participant"
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
      "Participants supprimés"
    );

  }catch(e){

    console.log(e);

    res.send(
      "Erreur suppression"
    );

  }

});

app.post(
"/supprimer-tournoi-complet",
async (req,res)=>{

  try{

    const { tournament_id } =
      req.body;

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

    res.send(
      "Tournoi supprimé"
    );

  }catch(e){

    console.log(e);

    res.send(
      "Erreur suppression tournoi"
    );

  }

});

app.post("/reset-tournoi", async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    if(!tournament_id){
      return res.send("Tournoi obligatoire");
    }

    await run(
      "DELETE FROM matches WHERE tournament_id=?",
      [tournament_id]
    );

    await run(
      "UPDATE participants SET group_name=NULL WHERE tournament_id=?",
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
    "SELECT * FROM participants WHERE tournament_id=?",
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

    if(m.played !== 1) continue;

    const a = table[m.player1_id];
    const b = table[m.player2_id];

    if(!a || !b) continue;

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
    }
    else if(s2 > s1){
      b.v++;
      a.d++;
      b.pts += 3;
    }
    else{
      a.n++;
      b.n++;
      a.pts++;
      b.pts++;
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
      b.bp - a.bp
    );

  }

  return groups;

}

app.get("/classement-poules/:id", async (req,res)=>{

  try{

    const result =
      await classementPoules(req.params.id);

    res.json(result);

  }catch(e){

    console.log(e);
    res.json({});

  }

});

app.post("/update-match-proof",(req,res)=>{

  const {
    match_id,
    score1,
    score2,
    photo_url
  } = req.body;

  db.get(
    "SELECT * FROM matches WHERE id=?",
    [match_id],
    (err,match)=>{

      if(!match){
        return res.send("Match introuvable");
      }

      if(match.locked === 1){
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
        return res.send("Match nul interdit en élimination directe");
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

      db.run(
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
        ],
   async ()=>{

    await ajouterXP(match.player1_id, 5);
    await ajouterXP(match.player2_id, 5);

   if(winner){

    await ajouterXP(winner, 10);

    await donnerBadge(
      winner,
      "🔥 Winner"
    );

  }

  res.send("Score validé + XP ajouté");

}
      );

    }
  );

});

app.post("/annuler-score", async (req,res)=>{

  try{

    const { match_id } = req.body;

    if(!match_id){
      return res.send("Match obligatoire");
    }

    const match = await get(
      "SELECT * FROM matches WHERE id=?",
      [match_id]
    );

    if(!match){
      return res.send("Match introuvable");
    }

    if(match.locked === 1){
      return res.send("Score verrouillé impossible à annuler");
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

app.post("/tirage-automatique-poule-pro", async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    const participants = await all(
      "SELECT * FROM participants WHERE tournament_id=?",
      [tournament_id]
    );

    if(participants.length !== 48){
      return res.send(
        "Il faut exactement 48 équipes. Actuel : " +
        participants.length +
        "/48"
      );
    }

    const existingMatches = await all(
      "SELECT * FROM matches WHERE tournament_id=?",
      [tournament_id]
    );

    if(existingMatches.length === 0){

      const lettres = "ABCDEFGHIJKL".split("");

      const melange =
        [...participants].sort(()=>Math.random() - 0.5);

      const matchs = [
        [0,1],
        [0,2],
        [0,3],
        [1,2],
        [1,3],
        [2,3]
      ];

      for(let g=0; g<12; g++){

        const groupe = lettres[g];

        const equipes =
          melange.slice(g * 4, g * 4 + 4);

        for(const equipe of equipes){

          await run(
            "UPDATE participants SET group_name=? WHERE id=?",
            [groupe,equipe.id]
          );

        }

        for(let i=0;i<matchs.length;i++){

          const [a,b] = matchs[i];

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
              groupe,
              i + 1,
              equipes[a].id,
              equipes[b].id
            ]
          );

        }

      }

      await run(
        "UPDATE tournaments SET status='active' WHERE id=?",
        [tournament_id]
      );

      return res.send("Poules créées : 12 groupes et 72 matchs");

    }

    const matchsPoule =
      existingMatches.filter(m => m.round === "POULE");

    if(matchsPoule.some(m => m.played !== 1)){
      return res.send("Finis tous les scores des poules");
    }

    const phaseFinaleExiste =
      existingMatches.some(m => m.round !== "POULE");

    if(!phaseFinaleExiste){

      const classement =
        await classementPoules(tournament_id);

      const qualifies = [];
      const troisiemes = [];

      for(const groupe of "ABCDEFGHIJKL".split("")){

        const equipes = classement[groupe];

        if(!equipes || equipes.length < 4){
          return res.send("Classement incomplet groupe " + groupe);
        }

        qualifies.push(equipes[0]);
        qualifies.push(equipes[1]);

        troisiemes.push(equipes[2]);

      }

      troisiemes.sort((a,b)=>
        b.pts - a.pts ||
        b.diff - a.diff ||
        b.bp - a.bp
      );

      qualifies.push(...troisiemes.slice(0,8));

      await run(
        `
        UPDATE matches
        SET locked=1
        WHERE tournament_id=?
        AND round='POULE'
        `,
        [tournament_id]
      );

      for(let i=0; i<32; i+=2){

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
            "16ES",
            (i/2) + 1,
            qualifies[i].id,
            qualifies[i+1].id
          ]
        );

      }

      return res.send("16es générés automatiquement");

    }

    const ordre = [
      "16ES",
      "8ES",
      "QUART",
      "DEMI",
      "FINALE"
    ];

    let tourActuel = null;

    for(const tour of ordre){

      if(existingMatches.some(m => m.round === tour)){
        tourActuel = tour;
      }

    }

    if(tourActuel === "FINALE"){

      const finale =
        existingMatches.find(m => m.round === "FINALE");

      if(!finale || finale.played !== 1){
        return res.send("La finale doit être jouée");
      }

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

      return res.send("Champion validé 🏆");

    }

    const prochain = {
      "16ES":"8ES",
      "8ES":"QUART",
      "QUART":"DEMI",
      "DEMI":"FINALE"
    };

    const matchsTour =
      existingMatches.filter(m => m.round === tourActuel);

    if(matchsTour.some(m => m.played !== 1)){
      return res.send("Finis tous les matchs du tour " + tourActuel);
    }

    const gagnants = [];
    const perdants = [];

    for(const m of matchsTour){

      if(Number(m.score1) > Number(m.score2)){
        gagnants.push(m.player1_id);
        perdants.push(m.player2_id);
      }
      else{
        gagnants.push(m.player2_id);
        perdants.push(m.player1_id);
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
          (i/2) + 1,
          gagnants[i],
          gagnants[i+1]
        ]
      );

    }

    if(tourActuel === "DEMI" && perdants.length >= 2){

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
          "3E PLACE",
          1,
          perdants[0],
          perdants[1]
        ]
      );

    }

    return res.send(
      prochain[tourActuel] +
      " généré automatiquement"
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
        WHEN '16ES' THEN 2
        WHEN '8ES' THEN 3
        WHEN 'QUART' THEN 4
        WHEN 'DEMI' THEN 5
        WHEN '3E PLACE' THEN 6
        WHEN 'FINALE' THEN 7
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

process.on("uncaughtException", err => {
  console.log("Erreur capturée :", err);
});

process.on("unhandledRejection", err => {
  console.log("Promesse rejetée :", err);
});

function escapeHtml(text){
  return String(text || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

app.get("/public-tournoi/:id", async (req,res)=>{

  try{

    const tournament_id = req.params.id;

    const tournoi = await get(
      "SELECT * FROM tournaments WHERE id=?",
      [tournament_id]
    );

    if(!tournoi){
      return res.send("Tournoi introuvable");
    }

    const classement = await classementPoules(tournament_id);

    const matches = await all(
      `
      SELECT
        m.*,
        p1.prenom AS player1_name,
        p2.prenom AS player2_name
      FROM matches m
      LEFT JOIN participants p1 ON p1.id=m.player1_id
      LEFT JOIN participants p2 ON p2.id=m.player2_id
      WHERE m.tournament_id=?
      ORDER BY
        CASE m.round
          WHEN 'POULE' THEN 1
          WHEN '16ES' THEN 2
          WHEN '8ES' THEN 3
          WHEN 'QUART' THEN 4
          WHEN 'DEMI' THEN 5
          WHEN '3E PLACE' THEN 6
          WHEN 'FINALE' THEN 7
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
      JOIN participants p ON p.id=t.champion_id
      WHERE t.id=?
      `,
      [tournament_id]
    ).catch(()=>null);

    const publicUrl =
      req.protocol + "://" + req.get("host") +
      "/public-tournoi/" + tournament_id;

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

.troisieme{
  background:#78350f;
}

button{
  padding:12px;
  border:none;
  border-radius:10px;
  background:#22c55e;
  font-weight:bold;
  cursor:pointer;
  margin:5px;
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
<h2>QR Code du tournoi</h2>
<p>Scanne pour voir les résultats en direct :</p>
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

    html += `<div class="card"><h2>Classements des poules</h2>`;

    for(const groupe of Object.keys(classement).sort()){

      if(groupe === "Sans groupe") continue;

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
<tr class="${i < 2 ? "qualifie" : i === 2 ? "troisieme" : ""}">
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

    html += `</div>`;

    html += `<div class="card"><h2>Matchs et résultats</h2>`;

    let current = "";

    for(const m of matches){

      const titre =
        m.round === "POULE"
        ? "Groupe " + m.group_name
        : m.round;

      if(titre !== current){
        current = titre;
        html += `<h3>${escapeHtml(titre)}</h3>`;
      }

      html += `
<div class="match">
<b>${escapeHtml(m.player1_name || "Équipe 1")}</b>
VS
<b>${escapeHtml(m.player2_name || "Équipe 2")}</b>
<br>
${m.played ? escapeHtml(m.score1 + " - " + m.score2) : "Non joué"}
${m.locked === 1 ? "<br>🔒 Verrouillé" : ""}
${m.proof_photo ? `<br><img src="${escapeHtml(m.proof_photo)}" style="max-width:100%;border-radius:10px;margin-top:10px;">` : ""}
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

      console.log("ERREUR UPLOAD EXACTE :", err.message, err.code);

      return res.status(400).json({
        ok:false,
        message:err.message || "Erreur upload"
      });

    }

    if(!req.file){

      console.log("AUCUN FICHIER RECU");

      return res.status(400).json({
        ok:false,
        message:"Aucune image reçue"
      });

    }

    console.log("IMAGE OK :", req.file.filename);

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

<meta
name="viewport"
content="width=device-width, initial-scale=1.0">

<title>${joueur.prenom} - SNUGAME</title>

<style>

body{
  margin:0;
  font-family:Arial,sans-serif;
  background:
    linear-gradient(180deg,#050816,#07111f);
  color:white;
  min-height:100vh;
  display:flex;
  justify-content:center;
  align-items:center;
  padding:20px;
}

.card{
  width:100%;
  max-width:450px;
  background:
    linear-gradient(180deg,#0f172a,#111c33);
  border:1px solid #334155;
  border-radius:24px;
  padding:25px;
  box-shadow:
    0 0 30px #1455ff55;
}

h1{
  margin-top:0;
  text-align:center;
  font-size:34px;
  color:#93c5fd;
}

.level{
  text-align:center;
  font-size:20px;
  margin-bottom:15px;
}

.bar{
  height:18px;
  background:#020617;
  border-radius:999px;
  overflow:hidden;
  margin-bottom:25px;
  border:1px solid #334155;
}

.fill{
  height:100%;
  width:${Math.min(joueur.xp || 0,100)}%;
  background:
    linear-gradient(90deg,#1455ff,#7c2cff);
}

.stats{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:12px;
}

.stat{
  background:#020617;
  border:1px solid #334155;
  border-radius:16px;
  padding:15px;
  text-align:center;
}

.stat h2{
  margin:0;
  color:#22c55e;
}

.small{
  color:#cbd5e1;
  margin-top:8px;
}

</style>

</head>

<body>

<div class="card">

<h1>${joueur.prenom}</h1>

<div class="level">
⭐ Niveau ${joueur.niveau}
</div>

<div class="bar">
<div class="fill"></div>
</div>

<div style="margin-bottom:20px;">

<h2 style="color:#facc15;">
🏆 Badges
</h2>

<div style="
display:flex;
flex-wrap:wrap;
gap:10px;
">

${
  badges.length
  ? badges.map(b=>`
      <div style="
      background:#020617;
      border:1px solid #334155;
      padding:10px 14px;
      border-radius:999px;
      ">
        ${b.badge}
      </div>
    `).join("")
  : "<p>Aucun badge</p>"
}

</div>

</div>

<div class="stats">

<div class="stat">
<h2>${joueur.matchs}</h2>
<div class="small">Matchs</div>
</div>

<div class="stat">
<h2>${joueur.victoires}</h2>
<div class="small">Victoires</div>
</div>

<div class="stat">
<h2>${joueur.defaites}</h2>
<div class="small">Défaites</div>
</div>

<div class="stat">
<h2>${joueur.buts}</h2>
<div class="small">Buts</div>
</div>

<div class="stat">
<h2>${joueur.points}</h2>
<div class="small">Points</div>
</div>

<div class="stat">
<h2>${joueur.xp}</h2>
<div class="small">XP</div>
</div>

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

    const participants = await all(
      "SELECT id FROM participants"
    );

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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ranking SNUGAME</title>

<style>
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:linear-gradient(180deg,#050816,#07111f);
  color:white;
}

header{
  padding:25px;
  text-align:center;
  background:linear-gradient(135deg,#1455ff,#7c2cff);
  box-shadow:0 0 30px #1455ff88;
}

.container{
  max-width:900px;
  margin:auto;
  padding:20px;
}

.card{
  background:#0f172a;
  border:1px solid #334155;
  border-radius:18px;
  padding:15px;
  margin:12px 0;
  display:flex;
  justify-content:space-between;
  align-items:center;
}

.rank{
  font-size:28px;
  font-weight:bold;
  color:#22c55e;
}

.name{
  font-size:20px;
  font-weight:bold;
  color:#93c5fd;
}

.small{
  color:#cbd5e1;
  font-size:13px;
}
</style>
</head>

<body>

<header>
<h1>🌍 Ranking Mondial SNUGAME</h1>
<p>Top joueurs eFootball</p>
</header>

<div class="container">
`;

    joueurs.forEach((j,i)=>{

      html += `
<div class="card">
  <div>
    <div class="rank">#${i+1}</div>
    <div class="name">${j.prenom}</div>
    <div class="small">Niveau ${j.niveau || 1} • XP ${j.xp || 0}</div>
  </div>

  <div>
    <b>${j.points || 0} pts</b><br>
    <span class="small">${j.victoires || 0} V • ${j.defaites || 0} D • ${j.matchs || 0} matchs</span>
  </div>
</div>
`;

    });

    html += `
</div>
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

    res.send("Preuve envoyée. L’admin va vérifier ton paiement.");

  }catch(e){

    console.log(e);
    res.send("Erreur preuve paiement");

  }

});

app.get("/admin-payments", async (req,res)=>{

  try{

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
      JOIN users ON users.id=payments.user_id
      ORDER BY payments.id DESC
      `
    );

    let html = `
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Admin Paiements - SNUGAME</title>
<style>
body{
  font-family:Arial,sans-serif;
  background:#07111f;
  color:white;
  padding:20px;
}
.card{
  background:#152238;
  border:1px solid #334155;
  border-radius:15px;
  padding:15px;
  margin:12px 0;
}
button{
  padding:12px;
  border:none;
  border-radius:10px;
  background:#22c55e;
  font-weight:bold;
  cursor:pointer;
}
a{color:#60a5fa;}
.pending{color:#f59e0b;}
.approved{color:#22c55e;}
</style>
</head>
<body>

<h1>Admin Paiements SNUGAME</h1>
<p>Valider les abonnements manuels</p>
`;

    paiements.forEach(p=>{

      html += `
<div class="card">

  <h2>${p.name}</h2>

  <p><b>Email :</b> ${p.email}</p>

  <p><b>Utilisateur ID :</b> ${p.user_id}</p>

  <p><b>Date :</b> ${p.created_at}</p>

  <p>
    <b>Status paiement :</b>
    <span class="${p.status === "approved" ? "approved" : "pending"}">
      ${p.status}
    </span>
  </p>

  <p><b>Abonnement actuel :</b> ${p.abonnement === 1 ? "Actif" : "Non actif"}</p>

  <p>
    <b>Preuve :</b>
    <a href="${p.preuve}" target="_blank">
      Ouvrir la preuve paiement
    </a>
  </p>

  ${
    p.status !== "approved"
    ? `
      <form method="POST" action="/admin-valider-paiement">
        <input type="hidden" name="payment_id" value="${p.id}">
        <input type="hidden" name="user_id" value="${p.user_id}">
        <button>
          Valider abonnement 1 mois
        </button>
      </form>
    `
    : "<p class='approved'>✅ Paiement déjà validé</p>"
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
      return res.send("Participant, titre et média obligatoires");
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

app.listen(PORT, () => {

  console.log(
    "Serveur lancé sur le port " + PORT
  );

});