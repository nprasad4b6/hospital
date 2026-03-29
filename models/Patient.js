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
    enum: ["MALE", "FEMALE", "OTHER"],
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
    enum: [
      "WAITING",
      "IN_PROGRESS",
      "DONE",
      "SKIPPED",
      "ON_HOLD",
      "SENT_FOR_TEST",
    ],
    default: "WAITING",
    required: true,
  },
  guardianName: {
    type: String,
  },
  relation: {
    type: String,
    enum: ["Father", "Mother", "Guardian", "Spouse"],
  },
  address: {
    type: String,
  },
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Doctor",
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
  completedAt: {
    type: Date,
    default: null,
  },
});

patientSchema.pre("validate", function (next) {
  if (this.status === "SENT_FOR_TEST" && !this.completedAt) {
    this.completedAt = null;
  }
  next();
});

module.exports = mongoose.model("Patient", patientSchema);
