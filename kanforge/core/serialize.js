export class StateSerializer {
    constructor() {
        this.serializers = new Map();
    }

   
    serialize(typeName, obj) {
        const serializer = this.serializers.get(typeName);
        if (!serializer) return obj;
        return serializer(obj);
    }

   
    register(typeName, serializerFn) {
        this.serializers.set(typeName, serializerFn);
    }
}
