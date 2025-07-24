import * as debug from '../util/debug';
import { MP4 } from '../util/mp4-generator.js';
import { AACRemuxer } from '../remuxer/aac.js';
import { H264Remuxer } from '../remuxer/h264.js';
import { H265Remuxer } from '../remuxer/h265.js';
import { appendByteArray, secToTime } from '../util/utils.js';
import Event from '../util/event';

export default class RemuxController extends Event {

    constructor(env) {
        super('remuxer');
        this.initialized = false;
        this.trackTypes = [];
        this.tracks = {};
        this.seq = 1;
        this.env = env;
        this.timescale = 1000;
        this.mediaDuration = 0;
        this.aacParser = null;
    }

    addTrack(type) {
        if (type === 'h265video' || type === 'h265both') {
            this.tracks.video = new H265Remuxer(this.timescale);
            this.trackTypes.push('video');
        }
        if (type === 'video' || type === 'both') {
            this.tracks.video = new H264Remuxer(this.timescale);
            this.trackTypes.push('video');
        }
        if (type === 'audio' || type === 'both' || type === 'h265both') {
            const aacRemuxer = new AACRemuxer(this.timescale);
            this.aacParser = aacRemuxer.getAacParser();
            this.tracks.audio = aacRemuxer;
            this.trackTypes.push('audio');
        }
    }

    reset() {
        for (let type of this.trackTypes) {
            this.tracks[type].resetTrack();
        }
        this.initialized = false;
    }

    destroy() {
        this.tracks = {};
        this.offAll();
    }

    flush() {
        if (!this.initialized) {
            if (this.isReady()) {
                this.dispatch('ready');
                this.initSegment();
                this.initialized = true;
                this.flush();
            }
        } else {
            for (let type of this.trackTypes) {
                let track = this.tracks[type];
                // L'array dei samples viene consumato: il contenuto delle unit (slices) viene accodato in un buffer (che costituirà il payload restituito) e parallelamente
                // viene generato un'array di 'samples MP4' ovvero un array di oggetti che contengono le informazioni necessarie per generare il payload completo MP4.
                let pay = track.getPayload();
                if (pay && pay.byteLength) {
                    const moof = MP4.moof(this.seq, track.dts, track.mp4track);
                    const mdat = MP4.mdat(pay);
                    let payload = appendByteArray(moof, mdat);
                    let data = {
                        type: type,
                        payload: payload,
                        dts: track.dts
                    };
                    if (type === 'video') {
                        data.fps = track.mp4track.fps;
                    }
                    this.dispatch('buffer', data);
                    let duration = secToTime(track.dts / this.timescale);
                    debug.log(`put segment (${type}): dts: ${track.dts} frames: ${track.mp4track.samples.length} second: ${duration}`);
                    track.flush();
                    this.seq++;
                }
            }
        }
    }

    initSegment() {
        let tracks = [];
        for (let type of this.trackTypes) {
            let track = this.tracks[type];
            if (this.env == 'browser') {
                let data = {
                    type: type,
                    payload: MP4.initSegment([track.mp4track], this.mediaDuration, this.timescale),
                };
                this.dispatch('buffer', data);
            } else {
                tracks.push(track.mp4track);
            }
        }
        if (this.env == 'node') {
            let data = {
                type: 'all',
                payload: MP4.initSegment(tracks, this.mediaDuration, this.timescale),
            };
            this.dispatch('buffer', data);
        }
        debug.log('Initial segment generated.');
    }

    isReady() {
        for (let type of this.trackTypes) {
            if (!this.tracks[type].readyToDecode || !this.tracks[type].samples.length) return false;
        }
        return true;
    }

    // 'data' è un oggetto contenente al più 2 array di 'frames' (audio e/o video) dove ogni 'frame' audio/video è un'array che contiene una o più NALUs,
    // di cui una sola è una slice vcl (video coding layer) IDR o non-IDR.
    remux(data) {
        for (let type of this.trackTypes) {
            let frames = data[type];
            if (type === 'audio' && this.tracks.video && !this.tracks.video.readyToDecode) continue; /* if video is present, don't add audio until video get ready */
            if (frames.length > 0) {
                this.tracks[type].remux(frames);
            }
        }
        this.flush();   // Qui viene generato il payload MP4
    }
}
