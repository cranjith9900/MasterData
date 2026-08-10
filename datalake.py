import pandas as pd
import io
import json
from datetime import datetime

# ---------- Load GOA Lookup ----------
goa_df = pd.read_csv("lookup_table_data_bms_goa.csv", dtype=str)

goa_map = {}

for _, row in goa_df.iterrows():
    goa_map[str(row["Username"]).strip()] = str(row["Group"]).strip()


targetHeaders = [
    "family_name",
    "given_name",
    "email",
    "primaryEmail",
    "email_verified",
    "userName",
    "id",
    "user_id",
    "employee_number",
    "companyEntityErpId",
    "countryCode",
    "defaultCurrencyCode",
    "managerId",
    "managerEmail",
    "active",
    "updated_at",
    "groups"
]

column_map = {
    "family_name": "legal_last_name",
    "given_name": "legal_first_name",
    "email": "email",
    "primaryEmail": "email",
    "userName": "bms_id",
    "id": "bms_id",
    "user_id": "bms_id",
    "employee_number": "bms_id",
    "companyEntityErpId": "bms_cmpy_cd",
    "countryCode": "bms_ctry_cd",
    "managerId": "bms_managers_id",
    "managerEmail": "manager_email"
}


def generate_groups(row):

    groups = []

    groups.append("Birthright")

    if str(row.get("bms_requisitioner", "")).strip().lower() == "yes":
        groups.append("Requisition")

    ctry_cd = str(row.get("bms_ctry_cd", "")).strip().upper()

    if ctry_cd == "US":
        groups.append("United States")
    elif ctry_cd == "IE":
        groups.append("Ireland")
    elif ctry_cd == "CH":
        groups.append("Switzerland")
    else:
        groups.append("Rest")

    cmpy_cd = str(row.get("bms_cmpy_cd", "")).strip().upper()

    if cmpy_cd not in ("0624", "0628"):
        groups.append("Non Rayzebio")

    return groups


def process(csv_file):

    df = pd.read_csv(csv_file, dtype=str)

    df_mapped = pd.DataFrame()

    for target_col in targetHeaders:

        if target_col in column_map:

            source_col = column_map[target_col]

            if source_col in df.columns:
                df_mapped[target_col] = df[source_col]
            else:
                df_mapped[target_col] = ""

        elif target_col != "groups":
            df_mapped[target_col] = ""

    df_mapped = df_mapped.fillna("")

    df_mapped["email_verified"] = True

    df_mapped["active"] = df["status"].apply(
        lambda x: str(x).strip().upper() == "ENABLED"
    )

    df_mapped["updated_at"] = datetime.now().isoformat()

    df_mapped["createIfMissing"] = True
    df_mapped["cognitoUser"] = True

    records = df_mapped.to_dict(orient="records")

    for i, record in enumerate(records):

        groups = generate_groups(df.iloc[i])

        username = str(record["userName"]).strip()

        goa_group = goa_map.get(username)

        if goa_group:

            if goa_group not in groups:
                groups.append(goa_group)

        record["groups"] = groups

    return records


if __name__ == "__main__":

    users = process("users.csv")

    print(json.dumps(users[:5], indent=2))