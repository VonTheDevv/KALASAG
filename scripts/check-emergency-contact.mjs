import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = process.cwd()
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kalasag-emergency-contact-'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function transpile(source, destination) {
  const result = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
    fileName: source,
    reportDiagnostics: true,
  })
  const errors = result.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  if (errors.length) throw new Error(`TypeScript transpilation failed for ${source}`)
  fs.writeFileSync(destination, result.outputText)
}

try {
  const profileModule = path.join(temporaryDirectory, 'emergencyProfile.mjs')
  const addressModule = path.join(temporaryDirectory, 'addressSearch.mjs')
  transpile(path.join(root, 'src/lib/emergencyProfile.ts'), profileModule)
  transpile(path.join(root, 'src/lib/addressSearch.ts'), addressModule)

  const profile = await import(pathToFileURL(profileModule).href)
  const address = await import(pathToFileURL(addressModule).href)
  const complete = {
    ...profile.EMPTY_EMERGENCY_FORM,
    firstName: 'JUAN',
    lastName: 'DELA CRUZ',
    bloodType: 'O+',
    allergies: 'NONE',
    medications: 'NONE',
    conditions: 'NONE',
    contactFirstName: 'MARIA',
    contactLastName: 'DELA CRUZ',
    contactNumber: '09123456789',
    contactRelation: 'Parent',
    streetAddress: '36 A. Bonifacio Street',
    city: 'Malabon',
    postalCode: '1471',
  }

  assert(profile.isEmergencyFormComplete(complete), 'Complete emergency contact form should pass validation')
  assert(profile.validateEmergencyForm({ ...complete, contactNumber: '0912345678' }).contactNumber, 'Ten-digit mobile number should fail')
  assert(profile.validateEmergencyForm({ ...complete, contactNumber: '091234567890' }).contactNumber, 'Twelve-digit mobile number should fail')
  assert(profile.validateEmergencyForm({ ...complete, contactNumber: '09123A56789' }).contactNumber, 'Non-numeric mobile number should fail')
  assert(profile.validateEmergencyForm({ ...complete, postalCode: '147' }).postalCode, 'Three-digit postal code should fail')

  const migrated = profile.migrateEmergencyForm({
    firstName: 'JUAN',
    lastName: 'CRUZ',
    contactName: 'MARIA SANTOS DELA CRUZ',
    contactNumber: '09123456789',
  })
  assert(migrated.contactFirstName === 'MARIA', 'Legacy contact first name was not preserved')
  assert(migrated.contactMiddleName === 'SANTOS DELA', 'Legacy contact middle name was not preserved')
  assert(migrated.contactLastName === 'CRUZ', 'Legacy contact last name was not preserved')

  const payload = {
    features: [
      {
        properties: {
          name: 'SM City Valenzuela',
          street: 'MacArthur Highway',
          city: 'Valenzuela',
          postcode: '1441',
          state: 'Metro Manila',
          countrycode: 'PH',
          osm_type: 'W',
          osm_id: 123,
        },
        geometry: { coordinates: [120.978, 14.689] },
      },
      {
        properties: {
          name: 'SM City Valenzuela',
          street: 'MacArthur Highway',
          city: 'Valenzuela',
          postcode: '1441',
          state: 'Metro Manila',
          countrycode: 'PH',
          osm_type: 'W',
          osm_id: 123,
        },
        geometry: { coordinates: [120.978, 14.689] },
      },
      {
        properties: { name: 'Outside', city: 'Taipei', countrycode: 'TW' },
        geometry: { coordinates: [121.565, 25.033] },
      },
    ],
  }
  const suggestions = address.normalizePhotonSuggestions(payload)
  assert(suggestions.length === 1, 'Address results should be Philippine-only and deduplicated')
  assert(suggestions[0].streetAddress === 'SM City Valenzuela, MacArthur Highway', 'Building and street were not combined')
  assert(suggestions[0].city === 'Valenzuela' && suggestions[0].postalCode === '1441', 'City and postal code were not normalized')

  console.log('Emergency contact logic passed (validation, migration, address normalization, and filtering).')
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
