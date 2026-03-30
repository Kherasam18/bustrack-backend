// =============================================================================
// src/utils/defaultPassword.js
// Generates the default password for a parent account on student admission
//
// Format: {SchoolCode}{Class}{Section}{RollNo}
// Example: BMS5C21
//
// Rules:
//   - School code is uppercased
//   - Section is uppercased
//   - Roll number is zero-padded to 2 digits only if < 10
//   - Result is always predictable so Sub-Admin can reprint it
// =============================================================================

function generateDefaultPassword(schoolCode, studentClass, section, rollNo) {
    const code = schoolCode.trim().toUpperCase();
    const cls = studentClass.trim();
    const sec = section ? section.trim().toUpperCase() : '';
    const roll = String(rollNo).trim();

    return `${code}${cls}${sec}${roll}`;
}

module.exports = { generateDefaultPassword };
