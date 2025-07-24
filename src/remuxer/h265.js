import * as debug from '../util/debug';
import { H265Parser } from '../parsers/h265.js';
import { BaseRemuxer } from './base.js';

export class H265Remuxer extends BaseRemuxer {

    constructor(timescale) {
        super();
        this.readyToDecode = false;
        this.nextDts = 0;
        this.dts = 0;
        this.mp4track = {
            id: BaseRemuxer.getTrackID(),
            type: 'h265video',
            len: 0,
            fragmented: true,
            vps: '',
            sps: '',
            pps: '',
            HEVCDecoderConfigurationRecord: {},
            fps: 30,
            width: 0,
            height: 0,
            timescale: timescale,
            duration: timescale,
            dumped: false,  // debugging purposes
            samples: [],
        };
        this.samples = [];
        this.h265 = new H265Parser(this);
    }

    resetTrack() {
        this.readyToDecode = false;
        this.mp4track.vps = '';
        this.mp4track.sps = '';
        this.mp4track.pps = '';
        this.nextDts = 0;
        this.dts = 0;
    }

    
    // 'frames' è un array di 'video frames' dove ogni 'frame' è un'array che contiene una o più NALUs,
    // di cui una sola è una slice vcl (video coding layer) IDR o non-IDR.
    remux(frames) {
        for (let frame of frames) {
            let units = [];
            let size = 0;
            for (let unit of frame.units) {
                // Le slice di ogni frame vengono accodate solo se il parsing ha successo (i.e: si tratta di un NAL-type H265 valido)
                if (this.h265.parseNAL(unit)) {
                    units.push(unit);
                    size += unit.getSize();
                }
            }
            if (units.length > 0 && this.readyToDecode) {
                this.mp4track.len += size;
                // I frames eventualmente 'ripuliti' delle NALUs indesiderate vengono riassemblati in 'samples', 
                // che verranno utilizzati per generare il payload MP4
                this.samples.push({
                    units: units,
                    size: size,
                    keyFrame: frame.keyFrame,
                    duration: frame.duration,
                    compositionTimeOffset: frame.compositionTimeOffset
                });
            }
        }
    }

    getPayload() {
        if (!this.isReady()) {
            return null;
        }
        let payload = new Uint8Array(this.mp4track.len);
        let offset = 0;
        let samples = this.mp4track.samples;
        let mp4Sample,
            duration;

        this.dts = this.nextDts;
        while (this.samples.length) {
            let sample = this.samples.shift(),
                units = sample.units;

            duration = sample.duration;
            if (duration <= 0) {
                debug.log(`h265remuxer: invalid sample duration at DTS: ${this.nextDts} :${duration}`);
                this.mp4track.len -= sample.size;
                continue;
            }
            this.nextDts += duration;
            mp4Sample = {
                size: sample.size,
                duration: duration,
                cts: sample.compositionTimeOffset || 0,
                flags: {
                    isLeading: 0,
                    isDependedOn: 0,
                    hasRedundancy: 0,
                    degradPrio: 0,
                    isNonSync: sample.keyFrame ? 0 : 1,
                    dependsOn: sample.keyFrame ? 2 : 1,
                },
            };

            for (const unit of units) {
                payload.set(unit.getData(), offset);
                offset += unit.getSize();
            }
            samples.push(mp4Sample);
        }

        if (!samples.length) return null;

        return new Uint8Array(payload.buffer, 0, this.mp4track.len);
    }
}
