const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(session({
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
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER,
    user_id INTEGER,
    comment TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    code TEXT,
    attempts INTEGER DEFAULT 0,
    blocked_until INTEGER DEFAULT 0,
    created_at INTEGER
  )
`);
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
      public_code TEXT
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
      buts INTEGER DEFAULT 0,
      buts_encaisses INTEGER DEFAULT 0,
      victoires INTEGER DEFAULT 0,
      matchs INTEGER DEFAULT 0,
      palmares TEXT DEFAULT '',
      meilleur_buteur TEXT DEFAULT ''
    )
  `);

});
db.run(`
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER,
    prenom TEXT
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
    proof_photo TEXT,
    meilleur_buteur TEXT DEFAULT ''
  )
`);

function connected(req){
  return req.session && req.session.userId;
}

function publicCode(){
  return "tournoi-" +
    Date.now() +
    "-" +
    Math.random().toString(36).substring(2,8);
}

app.post("/register", async (req,res)=>{

  try{

    const name = req.body.name;
    const email = req.body.email;
    const password = req.body.password;

    if(!name || !email || !password){
      return res.send("Tous les champs sont obligatoires");
    }

    const hash =
      await bcrypt.hash(password,10);

    db.run(
      "INSERT INTO users(name,email,password) VALUES(?,?,?)",
      [name,email,hash],
      function(err){

        if(err){
          console.log(err);
          return res.send("Email déjà utilisé");
        }

        req.session.userId = this.lastID;

        res.send("Compte créé et connecté");

      }
    );

  }
  catch(e){

    console.log(e);

    res.send("Erreur inscription");

  }

});

app.post("/login", async (req,res)=>{

  try{

    const email = req.body.email;
    const password = req.body.password;

    if(!email || !password){
      return res.send("Email et mot de passe obligatoires");
    }

    db.get(
      "SELECT * FROM users WHERE email=?",
      [email],
      async (err,user)=>{

        if(err){
          console.log(err);
          return res.send("Erreur serveur");
        }

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

  }
  catch(e){

    console.log(e);

    res.send("Erreur login");

  }

});

app.post("/abonnement",(req,res)=>{

  if(!connected(req)){
    return res.send("Connecte-toi d'abord");
  }

  db.run(
    "UPDATE users SET abonnement=1 WHERE id=?",
    [req.session.userId],
    (err)=>{

      if(err){
        return res.send("Erreur abonnement");
      }

      res.send("Abonnement activé : 5000 FCFA / mois");

    }
  );

});

app.get("/me",(req,res)=>{

  if(!connected(req)){
    return res.json({
      connected:false
    });
  }

  db.get(
    "SELECT id,name,email,abonnement FROM users WHERE id=?",
    [req.session.userId],
    (err,user)=>{

      if(err){
        return res.json({
          error:true
        });
      }

      res.json(user);

    }
  );

});

app.post("/tournoi",(req,res)=>{

  if(!connected(req)){
    return res.send("Connecte-toi d'abord");
  }

  const name = req.body.name;
  const max = Number(req.body.max_teams);

  if(!name || max < 10 || max > 100){
    return res.send("Le tournoi doit être entre 10 et 100 équipes");
  }

  db.get(
    "SELECT * FROM users WHERE id=?",
    [req.session.userId],
    (err,user)=>{

      if(err){
        return res.send("Erreur serveur");
      }

      if(!user){
        return res.send("Utilisateur introuvable");
      }

      if(user.abonnement !== 1){
        return res.send("Tu dois payer l'abonnement");
      }

      db.run(
        "INSERT INTO tournaments(user_id,name,max_teams,public_code) VALUES(?,?,?,?)",
        [
          req.session.userId,
          name,
          max,
          publicCode()
        ],
        function(err){

          if(err){
            console.log(err);
            return res.send("Erreur création tournoi");
          }

          res.send("Tournoi créé");

        }
      );

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

      if(err){
        return res.json([]);
      }

      res.json(rows);

    }
  );

});

app.post("/participant",(req,res)=>{

  if(!connected(req)){
    return res.send("Connecte-toi d'abord");
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

  db.run(
    `INSERT INTO participants(
      tournament_id,
      prenom,
      email,
      username,
      telephone,
      numero_serie,
      club_logo,
      preuve
    ) VALUES(?,?,?,?,?,?,?,?)`,
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
    (err)=>{

      if(err){
        return res.send("Erreur participant");
      }

      res.send("Participant ajouté");

    }
  );

});

app.get("/participants/:id",(req,res)=>{

  db.all(
    "SELECT * FROM participants WHERE tournament_id=?",
    [req.params.id],
    (err,rows)=>{

      if(err){
        return res.json([]);
      }

      res.json(rows);

    }
  );

});
app.get("/tirage/:id", (req, res) => {

  db.all(
    "SELECT id, prenom, club_logo FROM participants WHERE tournament_id=?",
    [req.params.id],
    (err, rows) => {

      if (err) {
        return res.json([]);
      }

      let joueurs = [...rows].sort(() => Math.random() - 0.5);
      let tours = [];
      let numeroTour = 1;

      while (joueurs.length > 1) {

        let matchs = [];
        let gagnants = [];

        for (let i = 0; i < joueurs.length; i += 2) {

          if (joueurs[i + 1]) {
            matchs.push({
              joueur1: joueurs[i],
              joueur2: joueurs[i + 1]
            });

            gagnants.push(joueurs[i]);
          } else {
            matchs.push({
              joueur1: joueurs[i],
              joueur2: null
            });

            gagnants.push(joueurs[i]);
          }

        }

        tours.push({
          tour: numeroTour,
          matchs: matchs
        });

        joueurs = gagnants;
        numeroTour++;
      }

      res.json(tours);

    }
  );

});
app.get("/classement/:id", (req, res) => {

  db.all(
    "SELECT * FROM participants WHERE tournament_id=?",
    [req.params.id],
    (err, rows) => {

      if(err){
        return res.json({
          meilleursButeurs: [],
          meilleureDefense: []
        });
      }

      const meilleursButeurs =
        [...rows].sort((a,b)=>b.buts-a.buts);

      const meilleureDefense =
        [...rows].sort((a,b)=>a.buts_encaisses-b.buts_encaisses);

      res.json({
        meilleursButeurs,
        meilleureDefense
      });

    }
  );

});
app.post("/generer-poules", async (req, res) => {
  const { tournament_id } = req.body;

  db.all(
    "SELECT * FROM participants WHERE tournament_id=?",
    [tournament_id],
    async (err, participants) => {
      if (err) return res.send("Erreur participants");

      if (participants.length !== 48) {
        return res.send("Il faut exactement 48 équipes pour générer les poules");
      }

      db.run("DELETE FROM matches WHERE tournament_id=?", [tournament_id]);

      const groupes = "ABCDEFGHIJKL".split("");
      const melange = [...participants].sort(() => Math.random() - 0.5);

      for (let g = 0; g < 12; g++) {
        const nomGroupe = groupes[g];
        const equipes = melange.slice(g * 4, g * 4 + 4);

        equipes.forEach(equipe => {
          db.run(
            "UPDATE participants SET group_name=? WHERE id=?",
            [nomGroupe, equipe.id]
          );
        });

        const matchs = [
          [0, 1],
          [2, 3],
          [0, 2],
          [1, 3],
          [0, 3],
          [1, 2]
        ];

        matchs.forEach((m, index) => {
          db.run(
            `INSERT INTO matches(
              tournament_id,
              round,
              group_name,
              match_order,
              player1_id,
              player2_id
            ) VALUES(?,?,?,?,?,?)`,
            [
              tournament_id,
              "POULE",
              nomGroupe,
              index + 1,
              equipes[m[0]].id,
              equipes[m[1]].id
            ]
          );
        });
      }

      res.send("Poules générées : 12 groupes de 4 équipes");
    }
  );
});
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.send("Déconnexion réussie");
  });
});
app.post("/reset-tournoi", (req, res) => {
  const { tournament_id } = req.body;

  if (!tournament_id) {
    return res.send("Tournoi obligatoire");
  }

  db.run(
    "DELETE FROM matches WHERE tournament_id=?",
    [tournament_id],
    () => {
      db.run(
        "UPDATE participants SET group_name=NULL WHERE tournament_id=?",
        [tournament_id],
        () => {
          res.send("Tournoi réinitialisé");
        }
      );
    }
  );
});
app.post("/commentaire", (req, res) => {
  const { tournament_id, comment } = req.body;

  if (!req.session.userId) {
    return res.send("Connecte-toi d'abord");
  }

  if (!tournament_id || !comment) {
    return res.send("Tournoi et commentaire obligatoires");
  }

  db.run(
    "INSERT INTO comments(tournament_id,user_id,comment) VALUES(?,?,?)",
    [tournament_id, req.session.userId, comment],
    () => {
      res.send("Commentaire ajouté");
    }
  );
});

app.get("/commentaires/:id", (req, res) => {
  db.all(
    "SELECT * FROM comments WHERE tournament_id=? ORDER BY id DESC",
    [req.params.id],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});
app.post("/forgot-password", (req, res) => {
  const { email } = req.body;

  const now = Date.now();

  db.get(
    "SELECT * FROM users WHERE email=?",
    [email],
    (err, user) => {
      if (!user) {
        return res.send("Aucun compte avec cet email");
      }

      db.get(
        "SELECT * FROM password_resets WHERE email=? ORDER BY id DESC LIMIT 1",
        [email],
        (err, last) => {
          if (last && last.blocked_until > now) {
            return res.send("Email bloqué pendant 5 heures");
          }

          const code = Math.floor(100000 + Math.random() * 900000).toString();

          db.run(
            "INSERT INTO password_resets(email,code,attempts,blocked_until,created_at) VALUES(?,?,?,?,?)",
            [email, code, 0, 0, now],
            () => {
              console.log("CODE RESET POUR", email, ":", code);
              res.send("Code envoyé. Regarde le terminal pour le code.");
            }
          );
        }
      );
    }
  );
});
app.post("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;

  const now = Date.now();

  if (!email || !code || !newPassword) {
    return res.send("Email, code et nouveau mot de passe obligatoires");
  }

  db.get(
    "SELECT * FROM password_resets WHERE email=? ORDER BY id DESC LIMIT 1",
    [email],
    async (err, reset) => {
      if (!reset) {
        return res.send("Aucun code trouvé");
      }

      if (reset.blocked_until > now) {
        return res.send("Email bloqué pendant 5 heures");
      }

      if (reset.code !== code) {
        const newAttempts = reset.attempts + 1;

        if (newAttempts >= 3) {
          const blockedUntil = now + 1000 * 60 * 60 * 5;

          db.run(
            "UPDATE password_resets SET attempts=?, blocked_until=? WHERE id=?",
            [newAttempts, blockedUntil, reset.id]
          );

          return res.send("Trop de tentatives. Email bloqué 5 heures");
        }

        db.run(
          "UPDATE password_resets SET attempts=? WHERE id=?",
          [newAttempts, reset.id]
        );

        return res.send("Code incorrect");
      }

      const hash = await bcrypt.hash(newPassword, 10);

      db.run(
        "UPDATE users SET password=? WHERE email=?",
        [hash, email],
        () => {
          db.run("DELETE FROM password_resets WHERE email=?", [email]);
          res.send("Mot de passe changé. Tu peux te connecter.");
        }
      );
    }
  );
});
app.post("/supprimer-participant", (req, res) => {

  const { participant_id } = req.body;

  if (!participant_id) {
    return res.send("Participant obligatoire");
  }

  db.run(
    "DELETE FROM participants WHERE id=?",
    [participant_id],
    () => {

      db.run(
        "DELETE FROM matches WHERE player1_id=? OR player2_id=?",
        [participant_id, participant_id],
        () => {
          res.send("Participant supprimé");
        }
      );

    }
  );

});
app.post("/supprimer-tous-participants", (req, res) => {
  const { tournament_id } = req.body;

  if (!tournament_id) {
    return res.send("Tournoi obligatoire");
  }

  db.run(
    "DELETE FROM participants WHERE tournament_id=?",
    [tournament_id],
    () => {
      db.run(
        "DELETE FROM matches WHERE tournament_id=?",
        [tournament_id],
        () => {
          res.send("Tous les participants sont supprimés");
        }
      );
    }
  );
});
app.post("/supprimer-participants-selection", (req, res) => {
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.send("Aucun participant sélectionné");
  }

  const placeholders = ids.map(() => "?").join(",");

  db.run(
    `DELETE FROM participants WHERE id IN (${placeholders})`,
    ids,
    () => {
      db.run(
        `DELETE FROM matches WHERE player1_id IN (${placeholders}) OR player2_id IN (${placeholders})`,
        [...ids, ...ids],
        () => {
          res.send("Participants sélectionnés supprimés");
        }
      );
    }
  );
});
app.post("/update-match-proof", (req, res) => {
  const {
    match_id,
    score1,
    score2,
    photo_url
  } = req.body;

  if (!match_id) {
    return res.send("Match obligatoire");
  }

  db.get(
    "SELECT * FROM matches WHERE id=?",
    [match_id],
    (err, match) => {
      if (!match) {
        return res.send("Match introuvable");
      }

      const s1 = Number(score1);
      const s2 = Number(score2);

      let winner = null;
      let loser = null;

      if (s1 > s2) {
        winner = match.player1_id;
        loser = match.player2_id;
      }

      if (s2 > s1) {
        winner = match.player2_id;
        loser = match.player1_id;
      }

      db.run(
        `UPDATE matches SET
          score1=?,
          score2=?,
          proof_photo=?,
          winner_id=?,
          loser_id=?,
          played=1
        WHERE id=?`,
        [
          s1,
          s2,
          photo_url,
          winner,
          loser,
          match_id
        ],
        () => {
          res.send("Résultat et photo enregistrés");
        }
      );
    }
  );
});

app.listen(PORT, () => {
  console.log("Serveur lancé sur le port " + PORT);
});