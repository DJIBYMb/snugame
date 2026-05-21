const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const db = new sqlite3.Database(
  path.join(__dirname, "database.sqlite")
);

app.use(express.json());
app.use(express.urlencoded({ extended:true }));
app.use(express.static("public"));

app.use(session({
  store:new SQLiteStore({
    db:"sessions.sqlite",
    dir:"."
  }),
  secret:"efootball-secret",
  resave:false,
  saveUninitialized:false,
  cookie:{
    maxAge:1000 * 60 * 60 * 24 * 30
  }
}));

function connected(req){
  return req.session && req.session.userId;
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

app.get("/", (req,res)=>{
  res.sendFile(__dirname + "/public/index.html");
});

db.serialize(()=>{

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      abonnement INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      max_teams INTEGER DEFAULT 48,
      status TEXT DEFAULT 'draft'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER,
      prenom TEXT,
      email TEXT,
      username TEXT,
      telephone TEXT,
      numero_serie TEXT,
      club_logo TEXT,
      preuve TEXT
    )
  `);
  
  db.run(`
  CREATE TABLE IF NOT EXISTS matches (
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
    played INTEGER DEFAULT 0
  )
`);

});

app.post("/register", async (req,res)=>{

  const { name, email, password } = req.body;

  if(!name || !email || !password){
    return res.send("Tous les champs sont obligatoires");
  }

  const hash = await bcrypt.hash(password,10);

  db.run(
    "INSERT INTO users(name,email,password) VALUES(?,?,?)",
    [name,email,hash],
    function(err){

      if(err){
        return res.send("Email déjà utilisé");
      }

      req.session.userId = this.lastID;

      console.log("Nouveau compte créé ID :", this.lastID, email);

      res.send("Compte créé");

    }
  );

});

app.post("/login", (req,res)=>{

  const { email, password } = req.body;

  console.log("Tentative login :", email);

  db.get(
    "SELECT * FROM users WHERE email=?",
    [email],
    async (err,user)=>{

      if(!user){
        return res.send("Compte introuvable");
      }

      const ok = await bcrypt.compare(password,user.password);

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

app.get("/me",(req,res)=>{

  if(!connected(req)){
    return res.json({connected:false});
  }

  db.get(
    "SELECT * FROM users WHERE id=?",
    [req.session.userId],
    (err,user)=>{
      res.json(user);
    }
  );

});

app.post("/abonnement",(req,res)=>{

  if(!connected(req)){
    return res.send("Connecte-toi");
  }

  db.run(
    "UPDATE users SET abonnement=1 WHERE id=?",
    [req.session.userId],
    ()=>{
      res.send("Abonnement activé");
    }
  );

});

app.post("/tournoi",(req,res)=>{

  if(!connected(req)){
    return res.send("Connecte-toi");
  }

  const {
    name,
    max_teams
  } = req.body;

  db.run(
    `
    INSERT INTO tournaments(
      user_id,
      name,
      max_teams
    )
    VALUES(?,?,?)
    `,
    [
      req.session.userId,
      name,
      max_teams
    ],
    ()=>{
      res.send("Tournoi créé");
    }
  );

});

app.get("/tournois",(req,res)=>{

  if(!connected(req)){
    return res.json([]);
  }

  db.all(
    "SELECT * FROM tournaments WHERE user_id=?",
    [req.session.userId],
    (err,rows)=>{
      res.json(rows || []);
    }
  );

});

app.post("/participant",(req,res)=>{

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

  db.run(
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
      username,
      telephone,
      numero_serie,
      club_logo,
      preuve
    ],
    ()=>{
      res.send("Participant ajouté");
    }
  );

});

app.get("/participants/:id",(req,res)=>{

  db.all(
    "SELECT * FROM participants WHERE tournament_id=?",
    [req.params.id],
    (err,rows)=>{
      res.json(rows || []);
    }
  );

});

app.post("/supprimer-participants-selection", async (req,res)=>{

  try{

    const { ids } = req.body;

    if(!ids || !Array.isArray(ids) || ids.length === 0){
      return res.send("Aucun participant sélectionné");
    }

    const placeholders = ids.map(()=>"?").join(",");

    await run(
      `DELETE FROM participants
       WHERE id IN (${placeholders})`,
      ids
    );

    res.send("Participant supprimé complètement");

  }catch(e){

    console.log(e);
    res.send("Erreur suppression participant");

  }

});

app.post("/supprimer-tournoi-complet", async (req,res)=>{

  const { tournament_id } = req.body;

  if(!tournament_id){
    return res.send("Tournoi obligatoire");
  }

  await run(
    "DELETE FROM participants WHERE tournament_id=?",
    [tournament_id]
  );

  await run(
    "DELETE FROM tournaments WHERE id=?",
    [tournament_id]
  );

  res.send("Tournoi supprimé complètement");

});

process.on("uncaughtException", err => {
  console.log("Erreur capturée :", err);
});

process.on("unhandledRejection", err => {
  console.log("Promesse rejetée :", err);
});

async function classementPoules(tournament_id){

  const teams = await all(
    "SELECT * FROM participants WHERE tournament_id=?",
    [tournament_id]
  );

  const matches = await all(
    "SELECT * FROM matches WHERE tournament_id=? AND round='POULE'",
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

    a.j++;
    b.j++;

    a.bp += Number(m.score1);
    a.bc += Number(m.score2);

    b.bp += Number(m.score2);
    b.bc += Number(m.score1);

    if(Number(m.score1) > Number(m.score2)){
      a.v++;
      b.d++;
      a.pts += 3;
    }
    else if(Number(m.score2) > Number(m.score1)){
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

app.post("/update-match-proof",(req,res)=>{

  const {
    match_id,
    score1,
    score2,
    photo_url
  } = req.body;

  if(!match_id){
    return res.send("Match obligatoire");
  }

  db.get(
    "SELECT * FROM matches WHERE id=?",
    [match_id],
    (err,match)=>{

      if(!match){
        return res.send("Match introuvable");
      }

      let winner = null;
      let loser = null;

      if(Number(score1) > Number(score2)){
        winner = match.player1_id;
        loser = match.player2_id;
      }

      if(Number(score2) > Number(score1)){
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
          Number(score1),
          Number(score2),
          photo_url || "",
          winner,
          loser,
          match_id
        ],
        ()=>{
          res.send("Score validé");
        }
      );

    }
  );

});

app.post("/tirage-automatique-poule-pro", async (req,res)=>{

  try{

    const { tournament_id } = req.body;

    const participants = await all(
      "SELECT * FROM participants WHERE tournament_id=?",
      [tournament_id]
    );

    if(participants.length !== 48){
      return res.send("Il faut exactement 48 équipes");
    }

    const existingMatches = await all(
      "SELECT * FROM matches WHERE tournament_id=?",
      [tournament_id]
    );

    if(existingMatches.length === 0){

      const lettres = "ABCDEFGHIJKL".split("");
      const melange = [...participants].sort(()=>Math.random() - 0.5);

      for(let g=0; g<12; g++){

        const groupe = lettres[g];
        const equipes = melange.slice(g * 4, g * 4 + 4);

        for(const equipe of equipes){
          await run(
            "UPDATE participants SET group_name=? WHERE id=?",
            [groupe,equipe.id]
          );
        }

        const matchs = [
          [0,1],
          [0,2],
          [0,3],
          [1,2],
          [1,3],
          [2,3]
        ];

        for(let i=0; i<matchs.length; i++){
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

      return res.send("Poules créées : 12 groupes, 72 matchs");
    }

    const matchsPoule = existingMatches.filter(m => m.round === "POULE");

    if(matchsPoule.some(m => m.played !== 1)){
      return res.send("Finis tous les scores des poules");
    }

    const phaseFinaleExiste =
      existingMatches.some(m => m.round !== "POULE");

    if(!phaseFinaleExiste){

      const classement = await classementPoules(tournament_id);

      const qualifies = [];
      const troisiemes = [];

      "ABCDEFGHIJKL".split("").forEach(groupe=>{

        const equipes = classement[groupe];

        if(!equipes || equipes.length < 4){
          return;
        }

        qualifies.push(equipes[0]);
        qualifies.push(equipes[1]);
        troisiemes.push(equipes[2]);

      });

      troisiemes.sort((a,b)=>
        b.pts - a.pts ||
        b.diff - a.diff ||
        b.bp - a.bp
      );

      qualifies.push(...troisiemes.slice(0,8));

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
            (i / 2) + 1,
            qualifies[i].id,
            qualifies[i + 1].id
          ]
        );
      }

      return res.send("16es générés automatiquement");
    }

    const ordre = ["16ES","8ES","QUART","DEMI","FINALE"];
    let tourActuel = null;

    for(const tour of ordre){
      if(existingMatches.some(m => m.round === tour)){
        tourActuel = tour;
      }
    }

    if(tourActuel === "FINALE"){

      const finale = existingMatches.find(m => m.round === "FINALE");

      if(!finale || finale.played !== 1){
        return res.send("La finale doit être jouée");
      }

      if(Number(finale.score1) === Number(finale.score2)){
        return res.send("La finale ne peut pas finir égalité");
      }

      const champion =
        Number(finale.score1) > Number(finale.score2)
        ? finale.player1_id
        : finale.player2_id;

      await run(
        "UPDATE tournaments SET status='finished' WHERE id=?",
        [tournament_id]
      );

      return res.send("Champion validé 🏆 ID : " + champion);
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

    for(const m of matchsTour){

      if(Number(m.score1) === Number(m.score2)){
        return res.send("Match nul interdit en élimination directe");
      }

      gagnants.push(
        Number(m.score1) > Number(m.score2)
        ? m.player1_id
        : m.player2_id
      );

    }

    for(let i=0; i<gagnants.length; i+=2){
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
          (i / 2) + 1,
          gagnants[i],
          gagnants[i + 1]
        ]
      );
    }

    return res.send(prochain[tourActuel] + " généré automatiquement");

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
      m.round,
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

app.listen(PORT, () => {
  console.log(
    "Serveur lancé sur le port " + PORT
  );
});