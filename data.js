
const STORAGE_KEY = "reborn_state";

let state = {
calories:0,
water:0,
chatHistory:[]
};

function loadState(){
const saved = localStorage.getItem(STORAGE_KEY);
if(saved){
state = JSON.parse(saved);
}
}

function saveState(){
localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
