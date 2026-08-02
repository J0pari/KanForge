export class LazyStream {
    constructor(head, tailThunk) {
        this.head = head;
        this._tailThunk = tailThunk;
        this._tail = null;
        this._error = null;
    }

    get tail() {
        if (this._tail === null && this._tailThunk) {
            try {
                this._tail = this._tailThunk();
            } catch (error) {
                this._error = error;
                this._tailThunk = null;
                throw error;
            }
            this._tailThunk = null;
        }
        if (this._error) {
            throw this._error;
        }
        return this._tail;
    }
    
    take(n) {
        const result = [];
        let current = this;
        for (let i = 0; i < n && current; i++) {
            result.push(current.head);
            current = current.tail;
        }
        return result;
    }
    
    map(f) {
        return new LazyStream(
            f(this.head),
            (this._tail !== null || this._tailThunk) ? () => this.tail.map(f) : null
        );
    }
    
   
    cons(element) {
        return new LazyStream(element, () => this);
    }
    
   
    append(element) {
        if (this._tail === null && !this._tailThunk) {
           
            return new LazyStream(
                this.head,
                () => new LazyStream(element, null)
            );
        }
       
        return new LazyStream(
            this.head,
            () => this.tail.append(element)
        );
    }
    
   
    concat(other) {
        if (this._tail === null && !this._tailThunk) {
            return new LazyStream(this.head, () => other);
        }
        return new LazyStream(
            this.head,
            () => this.tail.concat(other)
        );
    }
    
   
    static empty() {
        return null;
    }
    
   
    static fromArray(arr) {
        if (arr.length === 0) return null;
        return new LazyStream(
            arr[0],
            arr.length > 1 ? () => LazyStream.fromArray(arr.slice(1)) : null
        );
    }
    
    filter(pred) {
        if (pred(this.head)) {
            return new LazyStream(
                this.head,
                (this._tail !== null || this._tailThunk) ? () => this.tail.filter(pred) : null
            );
        }
        return this.tail ? this.tail.filter(pred) : null;
    }
    
    window(n) {
        if (n <= 0 || (this._tail === null && !this._tailThunk)) return null;
        
        const buffer = [];
        let current = this;
        for (let i = 0; i < n && current; i++) {
            buffer.push(current.head);
            current = current.tail;
        }
        
        if (buffer.length < n) return null;
        
        return new LazyStream(
            buffer,
            this.tail ? () => this.tail.window(n) : null
        );
    }
}
