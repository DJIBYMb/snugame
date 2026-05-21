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

app.listen(PORT, () => {
  console.log(
    "Serveur lancé sur le port " + PORT
  );
});