export class PullPromise {
    constructor(asyncThunk) {
        this._thunk = asyncThunk;
        this._promise = null;
        this._started = false;
    }

   
    pull() {
        if (!this._started) {
            this._promise = this._thunk();
            this._started = true;
        }
       
        return Promise.resolve(this._promise);
    }
    
   
    then(onResolve, onReject) {
        return new PullPromise(() => 
            this.pull().then(onResolve, onReject)
        );
    }
    
    map(f) {
        return new PullPromise(() => 
            this.pull().then(f)
        );
    }
}
