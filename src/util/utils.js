export function appendByteArray(buffer1, buffer2) {
    let tmp = new Uint8Array((buffer1.byteLength|0) + (buffer2.byteLength|0));
    tmp.set(buffer1, 0);
    tmp.set(buffer2, buffer1.byteLength|0);
    return tmp;
}

export function secToTime(sec) {
    let seconds,
        hours,
        minutes,
        result = '';

    seconds = Math.floor(sec);
    hours = parseInt(seconds / 3600, 10) % 24;
    minutes = parseInt(seconds / 60, 10) % 60;
    seconds = (seconds < 0) ? 0 : seconds % 60;

    if (hours > 0) {
        result += (hours < 10 ? '0' + hours : hours) + ':';
    }
    result += (minutes < 10 ? '0' + minutes : minutes) + ':' + (seconds < 10 ? '0' + seconds : seconds);
    return result;
}

// Extract Raw Byte Sequence Payload from a NAL unit by removing emulation prevention bytes (0x03)
export function extractRbsp(nalUnit) {
    let rbsp = new Uint8Array(nalUnit.length);
    let rbspIndex = 0, i = 0;
    let n = nalUnit.findIndex(value => value == 0x00 );
    if (n < 0) 
        return nalUnit;
    rbsp.set(nalUnit.slice(0, n));
    for (rbspIndex = i = n; i < nalUnit.length; i++) {
        // Check for emulation prevention three-byte sequence (0x000003)
        if (i > n+1 && nalUnit[i - 2] === 0x00 && nalUnit[i - 1] === 0x00 && nalUnit[i] === 0x03) {
            // Skip the emulation prevention byte (0x03)
            continue;
        }
        rbsp[rbspIndex++] = nalUnit[i];
    }
    return rbsp.subarray(0, rbspIndex);
}
