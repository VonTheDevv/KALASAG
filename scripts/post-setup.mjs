async function main() {
  throw new Error(
    'This legacy setup script is retired because it altered Supabase Auth configuration. Apply reviewed files under supabase/migrations instead.',
  )
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
