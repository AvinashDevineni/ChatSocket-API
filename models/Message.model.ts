import mongoose from 'mongoose';

export interface MessageInterface extends mongoose.Document {
    message: string;
}

const messageSchema = new mongoose.Schema<MessageInterface>({
    message: {
        type: String,
        required: true
    },
}, { timestamps: true });

const Message = mongoose.model("Message", messageSchema);
export default Message;
