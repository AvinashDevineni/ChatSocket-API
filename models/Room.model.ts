import mongoose from 'mongoose';

export interface RoomInterface extends mongoose.Document {
    name: string;
    messages: mongoose.Schema.Types.ObjectId[];
}

const roomSchema = new mongoose.Schema<RoomInterface>({
    name: {
        type: String,
        required: true
    },
    messages: [{
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        default: [],
        ref: 'Message'
    }],
}, { timestamps: true });

const Room = mongoose.model("Room", roomSchema);
export default Room;
