class BufferManager {
    #device = null;
    #numUsedBuffers = 0;
    #numFreeBuffers = 0;
    #freeBuffers = [];
    #usedBuffers = new Map();

    numBytesUsed = 0;
    numBytesAllocated = 0;

    constructor(device) {
        this.#device = device;
    }

    acquireBuffer(keyTag, usage, size, mappedAtCreation = false, reuse = true) {
        let buffer;

        if (reuse) {
            if (this.#usedBuffers.has(keyTag)) {
                buffer = this.#usedBuffers.get(keyTag);
            } else {
                if (this.#freeBuffers.length > 0) {
                    buffer = this.#freeBuffers.pop();
                    this.#usedBuffers.set(keyTag, buffer);
                } else {
                    buffer = this.#device.createBuffer({size, usage, mappedAtCreation});
                    this.#usedBuffers.set(keyTag, buffer);
                }
            }
        } else {
            buffer = this.#device.createBuffer({size, usage, mappedAtCreation});
        }

        return buffer;
    }

    releaseBuffer(keyTag, buffer, reuse = true) {
        if (this.#usedBuffers.has(keyTag)) {
            const usedBuffer = this.#usedBuffers.get(keyTag);
            if (reuse) {
                this.#freeBuffers.push(usedBuffer);
            } else {
                usedBuffer.destroy();
            }

            this.#usedBuffers.delete(keyTag);
        } else {
            if (!reuse) {
                if (this.#freeBuffers.indexOf(buffer) != -1) {
                    this.#freeBuffers[index] = this.#freeBuffers[this.#freeBuffers.length - 1];
                    this.#freeBuffers.pop();
                    buffer.destroy();
                }
            }
        }
        
        const index = bufferArray.index(buffer);
        if (index < 0) {
            throw new Error('cannot find the buffer in the buffer manager!');
        }
    }

    getNumUsedBuffers() {
        return this.#numUsedBuffers;
    }

    getNumFreeBuffers() {
        return this.#numFreeBuffers;
    }

    dispose() {
        this.#freeBuffers.forEach((buffers, key) => {
            buffers.forEach(buffer => {
                buffer.destroy();
            });
        });

        this.#usedBuffers.forEach((buffers, key) => {
            buffers.forEach(buffer => {
                buffer.destroy();
            });
        });

        this.#freeBuffers = new Map();
        this.#usedBuffers = new Map();
        this.#numUsedBuffers = 0;
        this.#numFreeBuffers = 0;
        this.numBytesUsed = 0;
        this.numBytesAllocated = 0;
    }

    // #getBufferKey(size, usage) {
    //     return `${size}_${usage}`;
    // }
};