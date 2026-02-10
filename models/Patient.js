const mongoose = require("mongoose");

const patientSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  email: {
    type: String,
  },
  tokenNumber: {
    type: Number,
    unique: true,
    required: true,
  },
  type: {
    type: String,
    enum: ["BOOKED", "WALK_IN"],
    default: "WALK_IN",
    required: true,
  },
  status: {
    type: String,
    enum: ["WAITING", "IN_PROGRESS", "DONE"],
    default: "WAITING",
    required: true,
  },
  department: {
    type: String,
    default: "General",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  startedAt: Date,
  completedAt: Date,
});

module.exports = mongoose.model("Patient", patientSchema);
