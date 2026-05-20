const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const db = new sqlite3.Database("./database.sqlite");
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

app.get("/", (req,res)=>{
  res.sendFile(__dirname + "/public/index.html");
});

function connected(req){
  return req.session && req.session.userId;
}
db.serialize(()=>{

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
      organizer_name TEXT,
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
      preuve TEXT,
      group_name TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER,
      round TEXT,
      group_name TEXT,
      player1_id INTEGER,
      player2_id INTEGER,
      score1 INTEGER DEFAULT NULL,
      score2 INTEGER DEFAULT NULL,
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
      res.send("Compte créé et connecté");
    }
  );

});

app.post("/login", (req,res)=>{

  const { email, password } = req.body;

  if(!email || !password){
    return res.send("Email et mot de passe obligatoires");
  }

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
    res.send("Déconnexion réussie");
  });
});

app.get("/me",(req,res)=>{

  if(!connected(req)){
    return res.json({ connected:false });
  }

  db.get(
    "SELECT id,name,email,abonnement FROM users WHERE id=?",
    [req.session.userId],
    (err,user)=>{
      res.json(user || { connected:false });
    }
  );

});

app.post("/abonnement",(req,res)=>{

  if(!connected(req)){
    return res.send("Connecte-toi d'abord");
  }

  db.run(
    "UPDATE users SET abonnement=1 WHERE id=?",
    [req.session.userId],
    ()=>{
      res.send("Abonnement activé");
    }
  );

});

app.post("/tournoi", async (req,res)=>{

  if(!connected(req)){
    return res.send("Connecte-toi d'abord");
  }

  const user = await get(
    "SELECT * FROM users WHERE id=?",
    [req.session.userId]
  );

  if(!user || user.abonnement !== 1){
    return res.send("Tu dois payer l'abonnement");
  }

  const active = await get(
    "SELECT * FROM tournaments WHERE user_id=? AND status='active'",
    [req.session.userId]
  );

  if(active){
    return res.send("Tu as déjà un tournoi actif");
  }

  const { name, organizer_name } = req.body;

  if(!name){
    return res.send("Nom tournoi obligatoire");
  }

  db.run(
    "INSERT INTO tournaments(user_id,name,organizer_name,max_teams,status) VALUES(?,?,?,?,?)",
    [
      req.session.userId,
      name,
      organizer_name || user.name,
      48,
      "draft"
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
    "SELECT * FROM tournaments WHERE user_id=? ORDER BY id DESC",
    [req.session.userId],
    (err,rows)=>{
      res.json(rows || []);
    }
  );

});

app.post("/participant", async (req,res)=>{

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

  if(!tournament_id || !prenom || !email){
    return res.send("Tournoi, prénom et email obligatoires");
  }

  const count = await get(
    "SELECT COUNT(*) AS total FROM participants WHERE tournament_id=?",
    [tournament_id]
  );

  if(count.total >= 48){
    return res.send("Maximum 48 équipes atteint");
  }

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
    ()=>{
      res.send("Participant ajouté");
    }
  );

});

app.get("/participants/:id",(req,res)=>{

  db.all(
    "SELECT * FROM participants WHERE tournament_id=? ORDER BY id",
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
      `DELETE FROM matches
       WHERE player1_id IN (${placeholders})
       OR player2_id IN (${placeholders})`,
      [...ids, ...ids]
    );

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

app.post("/supprimer-tous-participants", async (req,res)=>{

  const { tournament_id } = req.body;

  if(!tournament_id){
    return res.send("Tournoi obligatoire");
  }

  try{
  await run(
    "DELETE FROM comments WHERE tournament_id=?",
    [tournament_id]
  );
 }catch(e){}

  await run(
    "DELETE FROM matches WHERE tournament_id=?",
    [tournament_id]
  );

  res.send("Tous les participants sont supprimés");

});

app.post("/generer-poules", async (req,res)=>{

  try{

    const {
      tournament_id,
      group_size
    } = req.body;

    const taillePoule =
      Number(group_size || 4);

    const taillesAutorisees =
      [3,4,5,8,10];

    if(!taillesAutorisees.includes(taillePoule)){
      return res.send(
        "Taille de poule autorisée : 3, 4, 5, 8 ou 10"
      );
    }

    const participants =
      await all(
        "SELECT * FROM participants WHERE tournament_id=?",
        [tournament_id]
      );

    const total =
      participants.length;

    if(total < 9 || total > 100){
      return res.send(
        "Le tournoi doit avoir entre 9 et 100 participants"
      );
    }

    if(total % taillePoule !== 0){

      const manque =
        taillePoule - (total % taillePoule);

      return res.send(
        "Poules impossibles : il manque " +
        manque +
        " participant(s) pour faire des poules égales de " +
        taillePoule
      );

    }

    await run(
      "DELETE FROM matches WHERE tournament_id=?",
      [tournament_id]
    );

    await run(
      "UPDATE tournaments SET status='active' WHERE id=?",
      [tournament_id]
    );

    const melange =
      [...participants].sort(()=>Math.random() - 0.5);

    const lettres =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

    const nombreGroupes =
      total / taillePoule;

    for(let g=0; g<nombreGroupes; g++){

      const groupe =
        lettres[g] || ("G" + (g + 1));

      const equipes =
        melange.slice(
          g * taillePoule,
          g * taillePoule + taillePoule
        );

      for(let i=0; i<equipes.length; i++){

        await run(
          "UPDATE participants SET group_name=? WHERE id=?",
          [groupe,equipes[i].id]
        );

      }

      let ordre = 1;

      for(let i=0; i<equipes.length; i++){

        for(let j=i+1; j<equipes.length; j++){

          await run(
            `
            INSERT INTO matches(
              tournament_id,
              round,
              group_name,
              player1_id,
              player2_id
            ) VALUES(?,?,?,?,?)
            `,
            [
              tournament_id,
              "POULE",
              groupe,
              equipes[i].id,
              equipes[j].id
            ]
          );

          ordre++;

        }

      }

    }

    res.send(
      "Tirage automatique terminé : " +
      nombreGroupes +
      " groupes de " +
      taillePoule +
      " participants"
    );

  }catch(e){

    console.log(e);

    res.send("Erreur génération poules");

  }

});

app.get("/tirage/:id", (req,res)=>{

  db.all(
    `
    SELECT
      m.*,
      p1.prenom AS player1_name,
      p2.prenom AS player2_name,
      p1.club_logo AS player1_logo,
      p2.club_logo AS player2_logo
    FROM matches m
    LEFT JOIN participants p1 ON p1.id=m.player1_id
    LEFT JOIN participants p2 ON p2.id=m.player2_id
    WHERE m.tournament_id=?
    ORDER BY m.round, m.group_name, m.id
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

      db.run(
        `
        UPDATE matches
        SET
          score1=?,
          score2=?,
          proof_photo=?,
          played=1
        WHERE id=?
        `,
        [
          Number(score1),
          Number(score2),
          photo_url,
          match_id
        ],
        ()=>{
          res.send("Résultat et photo enregistrés");
        }
      );

    }
  );

});
async function classementPoules(tournament_id){

  const teams = await all(
    "SELECT * FROM participants WHERE tournament_id=?",
    [tournament_id]
  );

  const matches = await all(
    `
    SELECT * FROM matches
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

    a.j++;
    b.j++;

    a.bp += Number(m.score1);
    a.bc += Number(m.score2);

    b.bp += Number(m.score2);
    b.bc += Number(m.score1);

    if(m.score1 > m.score2){

      a.v++;
      b.d++;
      a.pts += 3;

    }
    else if(m.score2 > m.score1){

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

  const result =
    await classementPoules(req.params.id);

  res.json(result);

});
app.post("/generer-16es", async (req,res)=>{

  const { tournament_id } = req.body;

  const groups =
    await classementPoules(tournament_id);

  const premiers = [];
  const deuxiemes = [];
  const troisiemes = [];

  const lettres =
    "ABCDEFGHIJKL".split("");

  for(const g of lettres){

    if(!groups[g] || groups[g].length < 3){
      return res.send("Classement poules incomplet");
    }

    premiers.push(groups[g][0]);
    deuxiemes.push(groups[g][1]);
    troisiemes.push(groups[g][2]);

  }

  troisiemes.sort((a,b)=>
    b.pts - a.pts ||
    b.diff - a.diff ||
    b.bp - a.bp
  );

  const meilleursTroisiemes =
    troisiemes.slice(0,8);

  const qualifies = [
    ...premiers,
    ...deuxiemes,
    ...meilleursTroisiemes
  ];

  for(let i=0; i<32; i+=2){

    await run(
      `
      INSERT INTO matches(
        tournament_id,
        round,
        player1_id,
        player2_id
      ) VALUES(?,?,?,?)
      `,
      [
        tournament_id,
        "16ES",
        qualifies[i].id,
        qualifies[i+1].id
      ]
    );

  }

  res.send("16es de finale générés");

});
async function genererTourSuivant(
  tournament_id,
  current_round,
  next_round
){

  const matches = await all(
    `
    SELECT * FROM matches
    WHERE tournament_id=?
    AND round=?
    ORDER BY id
    `,
    [tournament_id,current_round]
  );

  if(matches.length === 0){
    return current_round + " introuvable";
  }

  const winners = [];

  for(const m of matches){

    if(m.played !== 1){
      return "Tous les matchs doivent être terminés";
    }

    if(Number(m.score1) > Number(m.score2)){
      winners.push(m.player1_id);
    }
    else{
      winners.push(m.player2_id);
    }

  }

  for(let i=0; i<winners.length; i+=2){

    await run(
      `
      INSERT INTO matches(
        tournament_id,
        round,
        player1_id,
        player2_id
      ) VALUES(?,?,?,?)
      `,
      [
        tournament_id,
        next_round,
        winners[i],
        winners[i+1]
      ]
    );

  }

  return next_round + " généré";

}

app.post("/generer-tour", async (req,res)=>{

  const {
    tournament_id,
    current_round,
    next_round
  } = req.body;

  const result =
    await genererTourSuivant(
      tournament_id,
      current_round,
      next_round
    );

  res.send(result);

});
app.get("/phase-finale/:id", (req,res)=>{

  db.all(
    `
    SELECT
      m.*,
      p1.prenom AS player1_name,
      p2.prenom AS player2_name
    FROM matches m
    LEFT JOIN participants p1 ON p1.id=m.player1_id
    LEFT JOIN participants p2 ON p2.id=m.player2_id
    WHERE
      m.tournament_id=?
      AND m.round!='POULE'
    ORDER BY m.round, m.id
    `,
    [req.params.id],
    (err,rows)=>{
      res.json(rows || []);
    }
  );

});
app.post("/valider-champion", async (req,res)=>{

  const { tournament_id } = req.body;

  const finale = await get(
    `
    SELECT * FROM matches
    WHERE tournament_id=?
    AND round='FINALE'
    `,
    [tournament_id]
  );

  if(!finale){
    return res.send("Finale introuvable");
  }

  let champion = null;

  if(Number(finale.score1) > Number(finale.score2)){
    champion = finale.player1_id;
  }
  else{
    champion = finale.player2_id;
  }

  await run(
    `
    UPDATE tournaments
    SET champion_id=?, status='finished'
    WHERE id=?
    `,
    [champion, tournament_id]
  );

  res.send("Champion validé 🏆");

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

function publicCode(){
  return "tournoi-" + Date.now();
}

function groupLetters(){
  return "ABCDEFGHIJKL".split("");
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

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});


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

app.post("/supprimer-tournoi-complet", async (req,res)=>{

  const { tournament_id } = req.body;

  if(!tournament_id){
    return res.send("Tournoi obligatoire");
  }

  try{
  await run(
    "DELETE FROM comments WHERE tournament_id=?",
    [tournament_id]
  );
}catch(e){}

  await run(
    "DELETE FROM participants WHERE tournament_id=?",
    [tournament_id]
  );

  await run(
    "DELETE FROM comments WHERE tournament_id=?",
    [tournament_id]
  );

  await run(
    "DELETE FROM tournaments WHERE id=?",
    [tournament_id]
  );

  res.send("Tournoi supprimé complètement");

});

app.listen(PORT, () => {
  console.log(
    "Serveur lancé sur le port " + PORT
  );
});