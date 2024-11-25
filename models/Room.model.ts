import mongoose from 'mongoose';
import Message from './Message.model.js';

const roomSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    // messages: [{
    //     type: mongoose.Schema.Types.ObjectId,
    //     required: true,
    //     default: []
    // }]
}, { timestamps: true });

const Room = mongoose.model("Room", roomSchema);
export default Room;
