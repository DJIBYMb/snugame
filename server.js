const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(session({
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: "."
  }),
  secret: "efootball-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

const db = new sqlite3.Database("./database.sqlite");

db.serialize(() => {

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
      max_teams INTEGER,
      public_code TEXT,
      champion_id INTEGER DEFAULT NULL
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
      preuve TEXT,
      group_name TEXT,
      buts INTEGER DEFAULT 0,
      buts_encaisses INTEGER DEFAULT 0,
      victoires INTEGER DEFAULT 0,
      matchs INTEGER DEFAULT 0,
      palmares TEXT DEFAULT '',
      meilleur_buteur TEXT DEFAULT ''
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

function connected(req){
  return req.session && req.session.userId;
}

function publicCode(){
  return "tournoi-" + Date.now();
}

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

      res.send("Compte créé");

    }
  );

});

app.post("/login", (req,res)=>{

  const { email, password } = req.body;

  db.get(
    "SELECT * FROM users WHERE email=?",
    [email],
    async (err,user)=>{

      if(!user){
        return res.send("Compte introuvable");
      }

      const ok =
        await bcrypt.compare(password,user.password);

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
      max_teams,
      public_code
    )
    VALUES(?,?,?,?)
    `,
    [
      req.session.userId,
      name,
      max_teams,
      publicCode()
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

app.post("/generer-poules", async (req,res)=>{

  const {
    tournament_id
  } = req.body;

  db.all(
    "SELECT * FROM participants WHERE tournament_id=?",
    [tournament_id],
    async (err,participants)=>{

      if(participants.length !== 48){
        return res.send("Il faut 48 équipes");
      }

      await new Promise(resolve=>{
        db.run(
          "DELETE FROM matches WHERE tournament_id=?",
          [tournament_id],
          resolve
        );
      });

      const groupes =
        "ABCDEFGHIJKL".split("");

      const melange =
        [...participants]
        .sort(()=>Math.random()-0.5);

      for(let g=0; g<12; g++){

        const groupe =
          groupes[g];

        const equipes =
          melange.slice(g*4,g*4+4);

        for(const equipe of equipes){

          await new Promise(resolve=>{
            db.run(
              "UPDATE participants SET group_name=? WHERE id=?",
              [groupe,equipe.id],
              resolve
            );
          });

        }

        const matchs = [
          [0,1],
          [2,3],
          [0,2],
          [1,3],
          [0,3],
          [1,2]
        ];

        for(let i=0;i<matchs.length;i++){

          const m = matchs[i];

          await new Promise(resolve=>{

            db.run(
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
                i+1,
                equipes[m[0]].id,
                equipes[m[1]].id
              ],
              resolve
            );

          });

        }

      }

      res.send("Poules générées");

    }
  );

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

      const result =
        Object.entries(grouped)
        .map(([tour,matchs])=>({
          tour,
          matchs
        }));

      res.json(result);

    }
  );

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
        UPDATE matches SET
          score1=?,
          score2=?,
          proof_photo=?,
          winner_id=?,
          loser_id=?,
          played=1
        WHERE id=?
        `,
        [
          score1,
          score2,
          photo_url,
          winner,
          loser,
          match_id
        ],
        ()=>{
          res.send("Résultat enregistré");
        }
      );

    }
  );

});

app.listen(PORT, () => {
  console.log(
    "Serveur lancé sur le port " + PORT
  );
});