const E=require('../engine_node.js');
function show(r){for(const x of r.results){console.log('> '+x.text.split('\n')[0].slice(0,70));if(x.output)console.log(x.output.map(l=>'  | '+l).join('\n'));if(x.grid){console.log('  '+x.grid.cols.join(' | '));for(const row of x.grid.rows.slice(0,12))console.log('  '+row.map(v=>v===null?'(null)':v).join(' | '));}if(x.msg)console.log('  '+x.msg);if(x.error){console.log('  !! '+x.error.code+': '+x.error.message+' @'+x.error.line+(x.error.stack.length?'\n     '+x.error.stack.join('\n     '):'')+(x.error.hint?'\n  hint: '+x.error.hint:''));if(x.error.internal)console.log(x.error.internal)}}}
module.exports=show;
if(require.main===module){const src=require('fs').readFileSync(process.argv[2],'utf8');show(E.runScript(src));}
