"""Development database reset utility.

Set DATABASE_URL in the calling shell. The connection value is never stored in
this repository.
"""

import os
import sys

try:
    import psycopg2
except ImportError:
    print("psycopg2 is required: pip install psycopg2-binary")
    raise SystemExit(1)


def main():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    if os.environ.get("APP_ENV") != "development" or os.environ.get("ALLOW_DATABASE_RESET") != "YES_I_UNDERSTAND":
        raise SystemExit(
            "Reset is restricted to APP_ENV=development and requires "
            "ALLOW_DATABASE_RESET=YES_I_UNDERSTAND"
        )

    confirm = input("\nWarning: this will delete development profile data. Continue? (yes/no): ")
    if confirm.lower() != "yes":
        print("Cancelled.")
        return

    try:
        connection_options = {"sslmode": "verify-full"}
        if os.environ.get("DATABASE_CA_CERT_PATH"):
            connection_options["sslrootcert"] = os.path.abspath(os.environ["DATABASE_CA_CERT_PATH"])
        with psycopg2.connect(database_url, **connection_options) as conn:
            with conn.cursor() as cur:
                cur.execute("TRUNCATE TABLE public.qr_codes CASCADE")
                cur.execute("UPDATE public.emergency_profiles SET first_name = '', middle_name = '', last_name = '', name_extension = '', blood_type = '', allergies = '', medications = '', conditions = '', contact_name = '', contact_first_name = '', contact_middle_name = '', contact_last_name = '', contact_number = '', contact_relation = '', street_address = '', city = '', postal_code = '', updated_at = now()")
        print("Database reset complete.")
    except Exception as error:
        print(f"Reset failed: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
