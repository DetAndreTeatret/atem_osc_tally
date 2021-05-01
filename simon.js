'use strict'

const { Atem } = require('atem-connection')
const myAtem = new Atem()
const osc = require('osc')
const properties = require ("properties");

let atemAddress = undefined;
let tallyOscAddress = undefined;
let tallyOscPort = undefined;
let oscPrefix = undefined;

properties.parse ("config.properties", { path: true }, function (error, obj){
    if (error) return console.error (error);
    console.log("Reading config...")

    atemAddress = obj.atemAddress
    tallyOscAddress = obj.tallyAddress
    tallyOscPort = obj.tallyPort
    oscPrefix = obj.oscPrefix

    console.log("Config was read successfully!")
});

const oscPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 57121,
    metadata: true
});

oscPort.on("ready", () => {
    console.log("OSC ready")
})

oscPort.on('error', console.error)

oscPort.open()

myAtem.on('error', console.error)

myAtem.connect(atemAddress).then(() => {
    console.log("Resetting lights...")
    for (let i = 0; i < 8; i++) {
        stopTally(i + 1)
        sleep(0.2)
    }
    console.log("Checking atem state")
    //The cached atem state is not updated until first request or state change
    //We request something here to force a state update, neccessary to read it's initial state
    myAtem.requestTime().then(() =>
        //Manually specify all paths that could be interesting
        updateState(myAtem.state, ["video.ME.0.programInput", "video.ME.0.transitionPosition", "video.ME.0.upstreamKeyers.0.onAir"]))

    console.log("Startup complete!")
})

myAtem.on('stateChanged', (state, pathToChange) => {
    updateState(state, pathToChange)
})

let inTransition = false;

function updateState(state, pathToChange){
    for (let i = 0; i < pathToChange.length; i++) {
        let path = pathToChange[i]
        if(path === 'video.ME.0.programInput'){
            startTally(state.video.mixEffects[0].programInput)
            stopTally(lastProgram)
            lastProgram = state.video.mixEffects[0].programInput;
            continue;
        }
        if(path === 'video.ME.0.transitionPosition'){
            //Transition done
            if(state.video.mixEffects[0].transitionPosition.handlePosition === 0){
                startTally(state.video.mixEffects[0].programInput)
                stopTally(state.video.mixEffects[0].previewInput)
                inTransition = false;
            }
            //Still in transition
            else{
                if(!inTransition) {
                    inTransition = true
                    startTally(state.video.mixEffects[0].programInput)
                    startTally(state.video.mixEffects[0].previewInput)
                }
            }
            continue
        }
        if(path === 'video.ME.0.upstreamKeyers.0.onAir'){
            const usk = state.video.mixEffects[0].upstreamKeyers[0]
            if(usk.onAir) startTally(usk.fillSource)
            else stopTally(usk.fillSource)
        }
        if(path !== 'info.lastTime') console.log(path)
    }
}

let lastProgram = 1;

function startTally(id){
    oscPort.send({
        address: createOSCAddress(id),
        args: [
            {
                type: 'f',
                value: '1'
            }
        ]
    }, tallyOscAddress, tallyOscPort)

}

function stopTally(id){
    oscPort.send({
        address: createOSCAddress(id),
        args: [
            {
                type: 'f',
                value: '0'
            }
        ]
    }, tallyOscAddress, tallyOscPort)
}

function createOSCAddress(id){
  return oscPrefix + id
}

function sleep(n) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n*1000);
}