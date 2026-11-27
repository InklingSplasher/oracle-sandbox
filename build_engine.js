const fs=require('fs');const files=fs.readdirSync('src').filter(f=>/^\d\d_.*\.js$/.test(f)).sort();
const code=files.map(f=>fs.readFileSync('src/'+f,'utf8')).join('\n');
fs.writeFileSync('engine.js',code);
fs.writeFileSync('engine_node.js',code+'\nmodule.exports={runScript,catalog,exportSQL,saveState,loadState,resetDB,SESSION,get DB(){return DB}};');
