'use strict'

const { Atem } = require('atem-connection')
const myAtem = new Atem()
const osc = require('osc')

const atemAddress = '192.168.1.240';
const tallyOscAddress = '192.168.1.10';
const tallyOscPort = 8000;

//Weather to send different OSC signals when inputs are live on different M/Es
const strictME = false; //TODO .properties

//Which sources are on air where?
//Stored as X1.X2
//X1 tells us where the source is used
//X1 is either "M" or "D" in addition to a single number, not spaced.
//"M" tells us that its used on a M/E row (program/transition/USK)
//"D" tells us that its used on a DSK
//
//X2 is the source that is used
//e.g M0.3 means source 3 is on air through M/E row 0
//and D1.4 means source 4 is on air through DSK 4
//
//This makes it possible to send seperate OSC signals for when sources are used on different M/E rows
//if for example only one row is the live output, while the other is for local monitoring
const sourcesOnAir = new Set()

let inTransition = false;
let lastProgram = 1;

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
    //Manually specify all paths that could be interesting
    myAtem.requestTime().then(() =>{
        const MEs = myAtem.state.video.mixEffects
        const v = "video."
        const m = "ME."
        const manualPaths = []
        for (let i = 0; i < MEs.length; i++) {
            manualPaths.push(v + m + i + ".programInput")
            manualPaths.push(v + m + i + ".transitionPosition")

            const usks = MEs[i].upstreamKeyers
            for (let i = 0; i > usks.length; i++) {
                manualPaths.push(v + m + i + ".upstreamKeyers." + usks[i])
            }
        }

        const dsks = myAtem.state.video.downstreamKeyers
        for (let i = 0; i < dsks.length; i++) {
            manualPaths.push(v + "downstreamKeyers." + i)
        }

        updateState(myAtem.state, manualPaths)
    })


    console.log("Startup complete!")
})

myAtem.on('stateChanged', (state, pathToChange) => {
    updateState(state, pathToChange)
})

//Updates the local state, refreshing tallies if any changes has happened
function updateState(state, pathToChange){
    //Cached to check difference after state update
    const oldActiveSources = new Set(sourcesOnAir)

    for (let i = 0; i < pathToChange.length; i++) {
        let path = pathToChange[i]

        if(!path.startsWith("video")) return;

        const split_path = path.split('.')

        if(path[1] === "ME"){
            const MEId = split_path[2]
            const location = split_path[3]

            const relevantME = state.video.mixEffects[MEId]
            const programInput = relevantME.programInput;
            const previewInput = relevantME.previewInput;

            const newOnAir = []
            const newOffAir = []

            if(location === "programInput"){
                newOnAir.push(programInput)
                newOffAir.push(lastProgram)

                lastProgram = programInput;
                continue;
            }

            if(location === "transitionPosition"){
                //Transition done
                if(relevantME.transitionPosition.handlePosition === 0){
                    newOnAir.push(programInput)
                    newOffAir.push(previewInput)
                    inTransition = false;
                }
                //Still in transition
                else{
                    if(!inTransition) {
                        inTransition = true
                        newOnAir.push(programInput)
                        newOnAir.push(previewInput)
                    }
                }
                continue
            }

            if(location === "upstreamKeyers"){
                const uskId = split_path[4]
                const usk = relevantME.upstreamKeyers[uskId]
                if(usk.onAir) newOnAir.push(usk.fillSource)
                else newOffAir.push(usk.fillSource)
            }

            for (const source in newOnAir) {
                sourcesOnAir.add("M" + MEId + "." + source)
            }

            for (const source in newOffAir) {
                sourcesOnAir.delete("M" + MEId + "." + source)
            }

        }

        if(path[1] === "downstreamKeyers"){
            const dskId = path[2] //TODO can dsk be audio??? confused
            const dsk = state.video.downstreamKeyers[dskId]
            if(dsk.onAir) sourcesOnAir.add("D" + dskId + "." + dsk.sources.fillSource)
            else sourcesOnAir.delete("D" + dskId + "." + dsk.sources.fillSource)
        }
    }

    const newActiveSources = new Set(sourcesOnAir)

    //Check the difference between the new and old sources
    //Removes sources present in both sets, meaning they are unchanged
    //Sources left in the new set needs to start tallies
    //Sources left in the old set needs to stop tallies
    for (let i = 0; i < newActiveSources.size; i++) {
        const stuff = newActiveSources[i]
        if(oldActiveSources.delete(stuff)){
            newActiveSources.delete(stuff)
        }
    }

    for (const stuff in newActiveSources) {
        startTally(stuff)
        sleep(0.2) //prevent packet loss
    }

    for (const stuff in oldActiveSources) {
        stopTally(stuff)
        sleep(0.2) //prevent packet loss
    }
}

let activeTallies = new Set()

//Tally functions gets a input and decides weather to send a start
//packet, and where to send it.
//If a tally is already running, this wont send another trigger
//If a tally is not running, calling stopTally wont send a trigger
function startTally(id) {

    if (activeTallies.includes(strictME ? id : id.split("."[1]))) return;

    activeTallies.add(id)

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
    if(!activeTallies.delete(strictME ? id : id.split("."[1]))) return;

    activeTallies.delete(id)
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
  return '/exec/1/' + id.split(".")[1] //avoid strict
    //TODO .properties
}

function sleep(n) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n*1000);
}

function replaceParams(string, replacements) { //Thanks stackoverflow
    return string.replace(/\{(\d+)\}/g, function() {
        return replacements[arguments[1]];
    });
}