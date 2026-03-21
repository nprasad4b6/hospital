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
  age: {
    type: Number,
    min: 0,
    max: 120,
  },
  gender: {
    type: String,
    enum: ["MALE", "FEMALE"],
    default: "FEMALE",
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
    enum: ["WAITING", "IN_PROGRESS", "DONE", "SKIPPED", "ON_HOLD"],
    default: "WAITING",
    required: true,
  },  guardianName: {
    type: String,
  },
  relation: {
    type: String,
    enum: ['Father', 'Mother', 'Guardian'],
  },
  address: {
    type: String,
  },  department: {
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
