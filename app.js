document.addEventListener("DOMContentLoaded", () => {

loadState();
updateUI();

function updateUI(){
document.getElementById("calories").innerText = state.calories;
document.getElementById("water").innerText = state.water + " cups";
}

window.addCalories = function(){
state.calories += 100;
saveState();
updateUI();
}

window.addWater = function(){
state.water += 1;
saveState();
updateUI();
}

window.sendChat = function(){

const input = document.getElementById("chatInput");
const msg = input.value.trim();
if(!msg) return;

const chat = document.getElementById("chat");

const user = document.createElement("div");
user.innerText = "You: " + msg;
chat.appendChild(user);

const reply = document.createElement("div");
reply.innerText = "Coach: Stay consistent today.";
chat.appendChild(reply);

input.value="";
}

document.addEventListener("keydown", e=>{

if(e.key==="w"){
addWater();
}

if(e.key==="c"){
addCalories();
}

});

});
