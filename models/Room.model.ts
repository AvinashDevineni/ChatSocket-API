import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    messages: {
        type: [String],
        required: true,
        default: []
    }
}, { timestamps: true });

const Room = mongoose.model("Room", roomSchema);
export default Room;
