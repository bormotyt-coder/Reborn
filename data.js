let state = {
  meals: [],
  water: 0,
  whoop: [],
  weightEntries: [],
  chatHistory: []
};

(function(){
  const saved = localStorage.getItem("reborn_state");
  if(saved){
    try{ state = JSON.parse(saved); }catch(e){}
  }
})();

function saveState(){
  localStorage.setItem("reborn_state", JSON.stringify(state));
}