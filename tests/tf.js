const fs=require('fs');
eval(fs.readFileSync('ui/content.js','utf8').replace(/^const /gm,'var '));
eval(fs.readFileSync('ui/format.js','utf8').replace(/^const FMT/m,'var FMT'));
const KW = new Set(('SELECT FROM WHERE AND OR NOT IN IS NULL LIKE BETWEEN EXISTS AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL USING GROUP BY HAVING ORDER ASC DESC NULLS FIRST LAST DISTINCT UNIQUE ALL ANY SOME UNION INTERSECT MINUS EXCEPT INSERT INTO VALUES UPDATE SET DELETE MERGE MATCHED THEN WHEN ELSE END CASE CREATE OR REPLACE TABLE VIEW INDEX SEQUENCE TRIGGER PROCEDURE FUNCTION PACKAGE BODY TYPE DROP ALTER ADD MODIFY RENAME COLUMN TO CONSTRAINT PRIMARY FOREIGN KEY REFERENCES CHECK DEFAULT CASCADE CONSTRAINTS TRUNCATE COMMIT ROLLBACK SAVEPOINT WITH FETCH NEXT ROWS ROW ONLY OFFSET OVER PARTITION ROWNUM LEVEL CONNECT PRIOR START SIBLINGS DECLARE BEGIN EXCEPTION IF ELSIF LOOP WHILE FOR EXIT CONTINUE RETURN RETURNING RAISE OUT CURSOR OPEN CLOSE BULK COLLECT LIMIT FORALL EXECUTE IMMEDIATE PRAGMA RECORD OF REF REVERSE GENERATED ALWAYS IDENTITY BEFORE AFTER INSTEAD EACH NEW OLD CONSTANT WITHIN TRUE FALSE EXEC DATE NUMBER VARCHAR2 COUNT SUM AVG MAX MIN ROUND NVL').split(' '));
const opts={caseMode:'upper', keywords:KW};
const E=require('../engine_node.js');
let fail=0;
const all=[['seed',SEED_SQL],['start',START_SHEET],...EXAMPLES.map(e=>[e.name,e.sql])];
for(const t of ['t2','t3','t5','t7']) all.push([t, fs.readFileSync('tests/'+t+'.sql','utf8')]);
for(const [n,s] of all){
  const f=FMT.format(s,opts);
  const same=FMT.sameTokens(s,f);
  const f2=FMT.format(f,opts);
  if(!same){fail++;console.log('TOKEN MISMATCH',n);}
  if(f2!==f){console.log('NOT IDEMPOTENT',n);}
  const pa=require('../engine_node.js');
}
console.log('fail',fail); if(fail) process.exitCode=1;
if(process.argv[2]){const s=all.find(x=>x[0]===process.argv[2])[1];console.log(FMT.format(s,opts));}
