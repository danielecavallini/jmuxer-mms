export class NALU {

    static get NDR() { return 1; }
    static get IDR() { return 5; }
    static get SEI() { return 6; }
    static get SPS() { return 7; }
    static get PPS() { return 8; }
    static get AUD() { return 9; }

    static get TYPES() {
        return {
            [NALU.IDR]: 'IDR',
            [NALU.SEI]: 'SEI',
            [NALU.SPS]: 'SPS',
            [NALU.PPS]: 'PPS',
            [NALU.NDR]: 'NDR',
            [NALU.AUD]: 'AUD',
        };
    }

    static type(nalu) {
        if (nalu.ntype in NALU.TYPES) {
            return NALU.TYPES[nalu.ntype];
        } else {
            return 'UNKNOWN';
        }
    }

    constructor(data) {
        this.payload = data;
        this.nri = (this.payload[0] & 0x60) >> 5; // nal_ref_idc
        this.ntype = this.payload[0] & 0x1f;
        this.isvcl = this.ntype == 1 || this.ntype == 5;
        this.stype = ''; // slice_type
        this.isfmb = false; // first_mb_in_slice
    }

    toString() {
        return `${NALU.type(this)}: NRI: ${this.getNri()}`;
    }

    getNri() {
        return this.nri;
    }

    type() {
        return this.ntype;
    }

    isKeyframe() {
        return this.ntype === NALU.IDR;
    }
    
    getPayload() {
        return this.payload;
    }

    getPayloadSize() {
        return this.payload.byteLength;
    }

    getSize() {
        return 4 + this.getPayloadSize();
    }

    getData() {
        const result = new Uint8Array(this.getSize());
        const view = new DataView(result.buffer);
        view.setUint32(0, this.getSize() - 4);
        result.set(this.getPayload(), 4);
        return result;
    }
}

export class H265NALU {

    static get IDR_W_RADL() { return 19; }
    static get IDR_N_LP() { return 20; }
    static get SEI_PREFIX() { return 39; }
    static get SEI_SUFFIX() { return 40; }
    static get VPS() { return 32; }
    static get SPS() { return 33; }
    static get PPS() { return 34; }
    static get AUD() { return 35; }

    static get TYPES() {
        return {
            [H265NALU.IDR_W_RADL]: 'IDR',
            [H265NALU.IDR_N_LP]: 'IDR',
            [H265NALU.SEI_PREFIX]: 'SEI',
            [H265NALU.SEI_SUFFIX]: 'SEI',
            [H265NALU.VPS]: 'VPS',
            [H265NALU.SPS]: 'SPS',
            [H265NALU.PPS]: 'PPS',
            [H265NALU.AUD]: 'AUD',
        };
    }

    static type(nalu) {
        if (nalu.ntype in H265NALU.TYPES) {
            return H265NALU.TYPES[nalu.ntype];
        } else if (nalu.isvcl) {
            return 'VCL NALU';
        } else {
            return 'UNKNOWN';
        }
    }

    constructor(data) {
        this.payload = data;
        this.ntype = this.payload[0] >> 1 & 0x3f; // nal_unit_type
        this.isvcl = (this.ntype >= 0 && this.ntype <= 23);
        this.is_first_slice_in_pict = false; // first_slice_in_picture_flag
    }

    toString() {
        return `${H265NALU.type(this)}`;
    }

    type() {
        return this.ntype;
    }

    isKeyframe() {
        return (this.ntype === H265NALU.IDR_W_RADL || this.ntype === H265NALU.IDR_N_LP);
    }
    
    getPayload() {
        return this.payload;
    }

    getPayloadSize() {
        return this.payload.byteLength;
    }

    getSize() {
        return 4 + this.getPayloadSize();
    }

    getData() {
        const result = new Uint8Array(this.getSize());
        const view = new DataView(result.buffer);
        view.setUint32(0, this.getSize() - 4);
        result.set(this.getPayload(), 4);
        return result;
    }
}
