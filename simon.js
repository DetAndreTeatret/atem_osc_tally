'use strict'

const { Atem } = require('atem-connection')
const myAtem = new Atem()
const osc = require('osc')

const atemAddress = '192.168.1.240';
const tallyOscAddress = '192.168.1.10';
const tallyOscPort = 8000;

//Which sources are on air where?
//Stored as "location.source"
//location tells us where the source is used
//location will be identical to the "pathToChange" given by atem-connection except
//for when dealing with transitionPosition, where a PRO or PRE is added to designate which
//part of the transition a source is
//
//source is the source that is used
//e.g video.ME.1.programInput.3 means source 3 is on air through the program output on M/E row 1
//and video.ME.0.transitionPositionPRE.6 means source 6 is on air as the destination of the ongoing
//transition on M/E row 0, [...]transitionPositionPRO[...] would be the origin picture in the transition
//
//This makes it possible to send separate OSC signals for when sources are used on different M/E rows
//if for example only one row is the live output, while the other is for local monitoring
//
//if non strict only the source is passed, no matter where its live
const sourcesOnAir = new Set();

const strictME = false; //TODO .properties //TODO implement thislol

let inTransition = false;
let lastProgram = undefined; //defined on startup

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
    console.log("Resetting tally lights...")
    for (let i = 0; i < 8; i++) {
        stopTally(i + 1)
        sleep(0.2)
    }
    console.log("Matching tally lights with current ATEM state...")
    //The cached atem state is not updated until first request or state change
    //We request something here to force a state update, necessary to read it's initial state
    myAtem.requestTime().then(() =>{
        //Manually specify all paths that could be interesting to update initial tally state
        const MEs = myAtem.state.video.mixEffects
        const v = "video."
        const m = "ME."
        const manualPaths = []
        for (let i = 0; i < MEs.length; i++) {
            manualPaths.push(v + m + i + ".programInput")
            manualPaths.push(v + m + i + ".transitionPosition")

            const usks = MEs[i].upstreamKeyers
            for (let j = 0; j > usks.length; j++) {
                manualPaths.push(v + m + i + ".upstreamKeyers." + usks[j])
            }
        }

        const dsks = myAtem.state.video.downstreamKeyers
        for (let i = 0; i < dsks.length; i++) {
            manualPaths.push(v + "downstreamKeyers." + i)
        }

        updateState(myAtem.state, manualPaths)
    })


    console.log("Tally lights ready!")
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

            if(location === "programInput"){
                sourcesOnAir.add(path + "." + programInput)
                sourcesOnAir.delete(path + "." + lastProgram)

                lastProgram = programInput;
                continue;
            }

            if(location === "transitionPosition"){
                //Transition done
                if(relevantME.transitionPosition.handlePosition === 0){
                    inTransition = false;
                    sourcesOnAir.add(path + "." + programInput)
                    sourcesOnAir.delete(path + "." + previewInput)
                }
                //Still in transition
                else{
                    if(!inTransition) {
                        inTransition = true
                        sourcesOnAir.add(path + "." + programInput)
                        sourcesOnAir.add(path + "." + previewInput)
                    }
                }
                continue
            }

            if(location === "upstreamKeyers"){
                const uskId = split_path[4]
                const usk = relevantME.upstreamKeyers[uskId]
                if(usk.onAir) sourcesOnAir.add(path + "." + usk.fillSource)
                else sourcesOnAir.delete(path + "." + usk.fillSource)
            }

        }

        if(path[1] === "downstreamKeyers"){
            const dskId = path[2] //TODO can dsk be audio??? confused
            const dsk = state.video.downstreamKeyers[dskId]
            if(dsk.onAir) sourcesOnAir.add(path +  "." + dsk.sources.fillSource)
            else sourcesOnAir.delete(path + "." + dsk.sources.fillSource)
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

    for (let i = 0; i < newActiveSources.size; i++) {
        startTally(newActiveSources[i])
        sleep(0.2) //prevent packet loss
    }

    for (let i = 0; i < oldActiveSources.size; i++) {
        stopTally(oldActiveSources[i])
        sleep(0.2) //prevent packet loss
    }
}

//Tally functions gets a input and decides weather to send an osc
//message, and where to send it.
//If a tally is already running, this wont send another trigger
//If a tally is not running, calling stopTally wont send a trigger
function startTally(id) {
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
    const splitId = id.split('.')
    const source = splitId[splitId.length - 1]
    sourcesOnAir.delete(id)
  return '/exec/1/' + (strictME ? id : source)
}

function sleep(n) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n*1000);
}